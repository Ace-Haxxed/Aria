#!/usr/bin/env python3
"""LoRA fine-tuning for Jarvis, run as a sidecar process.

Training is the one part of Jarvis that is not Rust. There is no LoRA trainer
for quantised models in the Rust ecosystem — llama.cpp removed its finetune
example and candle has no training path for quantised weights — so this calls
the Python stack that does, and reports back over stdout.

Every line printed to stdout is one JSON object, so the caller can parse
progress without guessing at prose:

    {"event": "status",   "message": "..."}
    {"event": "progress", "step": 12, "total": 300, "loss": 1.83, "epoch": 0.4}
    {"event": "done",     "output": "/path/to/adapter", "steps": 300}
    {"event": "error",    "message": "..."}

Run directly to train:

    python3 finetune.py --data ~/.jarvis/training_data/conversations.jsonl \\
                        --output ~/.jarvis/models/adapters/my-jarvis-v1

Or check whether the machine can train at all:

    python3 finetune.py --check
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

# Unsloth is 2-3x faster and uses far less memory, but only supports NVIDIA
# GPUs. Plain transformers+peft works everywhere including CPU, just slowly.
# Both are tried in that order so a machine gets the best it can run.
BACKEND_UNSLOTH = "unsloth"
BACKEND_TRANSFORMERS = "transformers"


def emit(event: str, **fields) -> None:
    """Write one JSON event and flush.

    Flushing matters: without it Python buffers stdout when it is a pipe, and
    the caller sees nothing until the process exits — which for a 45-minute
    training run means no progress at all.
    """
    print(json.dumps({"event": event, **fields}), flush=True)


def have(module: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def detect_gpu() -> tuple[bool, str]:
    """Is there a CUDA device? Decides the backend and the time estimate."""
    if not have("torch"):
        return False, "PyTorch is not installed"
    import torch

    if torch.cuda.is_available():
        return True, torch.cuda.get_device_name(0)
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        # Apple Silicon trains, but Unsloth's kernels are CUDA-only.
        return False, "Apple GPU (MPS) — training on CPU path"
    return False, "no CUDA device"


def choose_backend() -> str | None:
    has_gpu, _ = detect_gpu()
    if has_gpu and have("unsloth"):
        return BACKEND_UNSLOTH
    if have("transformers") and have("peft") and have("datasets"):
        return BACKEND_TRANSFORMERS
    return None


def install_dependencies(want_unsloth: bool) -> bool:
    """Install what is missing, into the user's environment.

    Deliberately not automatic on first launch: this pulls gigabytes of CUDA
    wheels, and doing that without asking is not something a user would
    forgive. It is only reached when they press the button.
    """
    packages = ["torch", "transformers", "peft", "datasets", "accelerate", "trl"]
    if want_unsloth:
        packages.insert(0, "unsloth")

    emit("status", message=f"Installing: {', '.join(packages)}. This can take a few minutes.")

    command = [sys.executable, "-m", "pip", "install", "--upgrade", *packages]
    # A virtualenv is the normal case; outside one, pip on a distro-managed
    # Python refuses without this flag.
    if sys.prefix == sys.base_prefix:
        command.append("--user")

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert process.stdout is not None
        for line in process.stdout:
            line = line.strip()
            # pip is verbose; surface only the lines that mean something.
            if line.startswith(("Collecting", "Successfully", "ERROR", "Installing")):
                emit("status", message=line[:200])
        return process.wait() == 0
    except Exception as exc:  # noqa: BLE001 — reported, not swallowed
        emit("error", message=f"Installation failed: {exc}")
        return False


def load_pairs(path: str) -> list[dict]:
    """Read the conversation pairs Jarvis has been collecting.

    Only rated-good and unrated pairs are used. A thumbs-down is the user
    saying "not like that", so training on it would teach exactly the wrong
    thing — it is dropped rather than weighted.
    """
    pairs: list[dict] = []
    rejected = 0

    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                # One corrupt line must not lose the rest of the dataset.
                continue

            if record.get("quality_score") == 0:
                rejected += 1
                continue

            user = (record.get("user") or "").strip()
            assistant = (record.get("assistant") or "").strip()
            if user and assistant:
                pairs.append({"user": user, "assistant": assistant})

    emit(
        "status",
        message=f"Loaded {len(pairs)} conversations ({rejected} rated unhelpful, skipped).",
    )
    return pairs


def to_chat_text(pair: dict) -> str:
    """One training example in ChatML, which every instruct model understands."""
    return (
        f"<|im_start|>user\n{pair['user']}<|im_end|>\n"
        f"<|im_start|>assistant\n{pair['assistant']}<|im_end|>"
    )


def train(args: argparse.Namespace) -> int:
    pairs = load_pairs(args.data)
    if len(pairs) < args.min_pairs:
        emit(
            "error",
            message=(
                f"Only {len(pairs)} usable conversations. At least {args.min_pairs} are needed "
                "for a fine-tune that improves anything."
            ),
        )
        return 1

    backend = choose_backend()
    if backend is None:
        if not args.auto_install:
            emit("error", message="The training libraries are not installed.")
            return 1
        has_gpu, _ = detect_gpu()
        if not install_dependencies(want_unsloth=has_gpu):
            emit("error", message="The training libraries could not be installed.")
            return 1
        backend = choose_backend()
        if backend is None:
            emit("error", message="The training libraries are still unavailable after install.")
            return 1

    has_gpu, device_name = detect_gpu()
    emit("status", message=f"Backend: {backend}. Device: {device_name}.")

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)

    try:
        if backend == BACKEND_UNSLOTH:
            return train_unsloth(args, pairs)
        return train_transformers(args, pairs, has_gpu)
    except KeyboardInterrupt:
        emit("error", message="Training was cancelled.")
        return 130
    except Exception as exc:  # noqa: BLE001 — the caller needs the reason
        emit("error", message=f"Training failed: {exc}")
        return 1


class ProgressReporter:
    """Turn the trainer's callbacks into progress events.

    Implemented against the transformers callback interface, which Unsloth
    also uses — it wraps the same Trainer underneath.
    """

    def __init__(self, total_steps: int):
        self.total = total_steps
        self.started = time.time()

    def __call__(self, step: int, loss: float | None, epoch: float | None) -> None:
        elapsed = time.time() - self.started
        remaining = (elapsed / step) * (self.total - step) if step > 0 else 0.0
        emit(
            "progress",
            step=step,
            total=self.total,
            loss=round(loss, 4) if loss is not None else None,
            epoch=round(epoch, 2) if epoch is not None else None,
            elapsed_seconds=round(elapsed),
            eta_seconds=round(remaining),
        )


def build_callback(reporter: ProgressReporter):
    from transformers import TrainerCallback

    class Emitter(TrainerCallback):
        def on_log(self, _args, state, _control, logs=None, **_kwargs):
            if not logs or "loss" not in logs:
                return
            reporter(state.global_step, logs.get("loss"), state.epoch)

    return Emitter()


def train_unsloth(args: argparse.Namespace, pairs: list[dict]) -> int:
    from unsloth import FastLanguageModel
    from datasets import Dataset
    from trl import SFTTrainer
    from transformers import TrainingArguments

    emit("status", message=f"Loading {args.model}…")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model,
        max_seq_length=args.max_seq_length,
        load_in_4bit=True,
    )

    # Rank 16 across the attention and MLP projections is the configuration
    # that reliably captures style and phrasing without needing the data
    # volume a larger rank demands.
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        lora_alpha=16,
        lora_dropout=0.0,
        bias="none",
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        use_gradient_checkpointing="unsloth",
    )

    dataset = Dataset.from_dict({"text": [to_chat_text(p) for p in pairs]})
    steps = max(1, (len(pairs) // args.batch_size) * args.epochs)
    reporter = ProgressReporter(steps)

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=args.max_seq_length,
        args=TrainingArguments(
            per_device_train_batch_size=args.batch_size,
            gradient_accumulation_steps=4,
            num_train_epochs=args.epochs,
            learning_rate=args.learning_rate,
            logging_steps=1,
            optim="adamw_8bit",
            output_dir=os.path.join(args.output, "checkpoints"),
            report_to="none",
            save_strategy="no",
        ),
        callbacks=[build_callback(reporter)],
    )

    emit("status", message=f"Training for {args.epochs} epochs (~{steps} steps).")
    trainer.train()

    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)
    emit("done", output=args.output, steps=steps, backend=BACKEND_UNSLOTH)
    return 0


def train_transformers(args: argparse.Namespace, pairs: list[dict], has_gpu: bool) -> int:
    """The portable path: no Unsloth, works on CPU and Apple Silicon."""
    import torch
    from datasets import Dataset
    from peft import LoraConfig, get_peft_model
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        DataCollatorForLanguageModeling,
        Trainer,
        TrainingArguments,
    )

    emit("status", message=f"Loading {args.model}…")
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=torch.float16 if has_gpu else torch.float32,
        device_map="auto" if has_gpu else None,
    )

    model = get_peft_model(
        model,
        LoraConfig(
            r=16,
            lora_alpha=16,
            lora_dropout=0.0,
            bias="none",
            task_type="CAUSAL_LM",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        ),
    )

    def tokenize(batch):
        return tokenizer(
            batch["text"],
            truncation=True,
            max_length=args.max_seq_length,
            padding="max_length",
        )

    dataset = Dataset.from_dict({"text": [to_chat_text(p) for p in pairs]})
    dataset = dataset.map(tokenize, batched=True, remove_columns=["text"])

    steps = max(1, (len(pairs) // args.batch_size) * args.epochs)
    reporter = ProgressReporter(steps)

    trainer = Trainer(
        model=model,
        train_dataset=dataset,
        data_collator=DataCollatorForLanguageModeling(tokenizer, mlm=False),
        args=TrainingArguments(
            per_device_train_batch_size=args.batch_size,
            gradient_accumulation_steps=4,
            num_train_epochs=args.epochs,
            learning_rate=args.learning_rate,
            logging_steps=1,
            output_dir=os.path.join(args.output, "checkpoints"),
            report_to="none",
            save_strategy="no",
            fp16=has_gpu,
        ),
        callbacks=[build_callback(reporter)],
    )

    emit("status", message=f"Training for {args.epochs} epochs (~{steps} steps).")
    trainer.train()

    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)
    emit("done", output=args.output, steps=steps, backend=BACKEND_TRANSFORMERS)
    return 0


def report_readiness(data_path: str | None) -> int:
    """Describe what this machine can do, without training anything."""
    has_gpu, device = detect_gpu()
    backend = choose_backend()

    usable = 0
    if data_path and os.path.exists(data_path):
        try:
            with open(data_path, "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if record.get("quality_score") != 0 and record.get("user") and record.get("assistant"):
                        usable += 1
        except OSError:
            usable = 0

    emit(
        "check",
        python=sys.version.split()[0],
        gpu=has_gpu,
        device=device,
        backend=backend,
        ready=backend is not None,
        installable=have("pip") or True,
        pairs=usable,
        # Rough, from observed throughput: a GPU does a few steps a second,
        # a CPU a few seconds a step.
        estimated_minutes=max(1, round(usable * 3 / (60 if has_gpu else 2))),
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="LoRA fine-tuning for Jarvis")
    parser.add_argument("--data", help="conversations.jsonl to train on")
    parser.add_argument("--output", help="directory to write the adapter to")
    parser.add_argument(
        "--model",
        default="unsloth/Phi-3.5-mini-instruct",
        help="base model to adapt",
    )
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--max-seq-length", type=int, default=2048)
    parser.add_argument("--min-pairs", type=int, default=50)
    parser.add_argument(
        "--auto-install",
        action="store_true",
        help="install the training libraries if they are missing",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="report whether this machine can train, and exit",
    )
    args = parser.parse_args()

    if args.check:
        return report_readiness(args.data)

    if not args.data or not args.output:
        emit("error", message="--data and --output are required.")
        return 2
    if not os.path.exists(args.data):
        emit("error", message=f"No training data at {args.data}.")
        return 1

    return train(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        # Jarvis stopped reading — it cancelled. Not an error.
        sys.exit(0)
