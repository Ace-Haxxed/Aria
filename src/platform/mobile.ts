/**
 * Mobile tools, backed by Capacitor plugins.
 *
 * The mobile surface is deliberately smaller than desktop: iOS and Android
 * sandbox applications, so there is no screen control, no window management and
 * no shell. What is here is what the platforms actually permit.
 */
import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Clipboard } from '@capacitor/clipboard';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Browser } from '@capacitor/browser';
import { Network } from '@capacitor/network';
import { Share } from '@capacitor/share';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Device } from '@capacitor/device';
import type { PlatformInfo, ToolDefinition } from '@/core/types';
import { argNumber, argString, defineTool, fail, ok, p } from '@/core/tools/base';
import { sharedTools, extractReadableText } from '@/core/tools/web';
import { complete } from '@/core/llm';
import { useSettings } from '@/store/settings';
import { httpGet } from '@/lib/http';
import { formatBytes, uid } from '@/lib/utils';

const MOBILE: Array<'mobile'> = ['mobile'];

/** Sandboxed root for everything ARIA reads or writes on a phone. */
const ROOT = Directory.Data;

export async function mobilePlatformInfo(): Promise<PlatformInfo> {
  const info = await Device.getInfo();

  return {
    os: Capacitor.getPlatform() === 'ios' ? 'ios' : 'android',
    isMobile: true,
    isDesktop: false,
    arch: info.model ?? 'unknown',
    osVersion: `${info.operatingSystem} ${info.osVersion}`,
    sessionType: 'none',
    compositor: 'none',
    tools: {},
  };
}

/** Request the permissions a tool needs, the first time it is used. */
async function ensureNotificationPermission(): Promise<boolean> {
  const status = await LocalNotifications.checkPermissions();
  if (status.display === 'granted') return true;
  const asked = await LocalNotifications.requestPermissions();
  return asked.display === 'granted';
}

export async function mobileTools(): Promise<ToolDefinition[]> {
  return [
    ...sharedTools(),

    defineTool({
      name: 'take_photo',
      description:
        'Open the camera, take a photo, and analyse it. Use this when the user asks what ' +
        'something is, or to read something in the physical world.',
      capability: 'camera',
      risk: 'medium',
      platforms: MOBILE,
      parameters: {
        question: p.string('What to determine about the photo. Defaults to a description.'),
      },
      async run(args) {
        const photo = await Camera.getPhoto({
          quality: 80,
          allowEditing: false,
          resultType: CameraResultType.DataUrl,
          source: CameraSource.Camera,
          // Keep it small: a full-resolution phone photo is a very expensive
          // number of vision tokens for no extra accuracy.
          width: 1024,
        });

        if (!photo.dataUrl) return fail('The camera returned no image.');

        const question =
          args.question != null
            ? argString(args, 'question')
            : 'Describe what is in this photo, concisely and specifically.';

        const { llm } = useSettings.getState().settings;
        const answer = await complete({ ...llm, model: llm.visionModel || llm.model }, [
          {
            id: uid('m'),
            role: 'user',
            content: question,
            timestamp: Date.now(),
            images: [photo.dataUrl],
          },
        ]);

        return ok(answer.trim(), { image: photo.dataUrl });
      },
    }),

    defineTool({
      name: 'pick_photo',
      description: 'Let the user choose a photo from their library, then analyse it.',
      capability: 'camera',
      risk: 'medium',
      platforms: MOBILE,
      parameters: {
        question: p.string('What to determine about the photo.'),
      },
      async run(args) {
        const photo = await Camera.getPhoto({
          quality: 80,
          resultType: CameraResultType.DataUrl,
          source: CameraSource.Photos,
          width: 1024,
        });
        if (!photo.dataUrl) return fail('No photo was chosen.');

        const question =
          args.question != null
            ? argString(args, 'question')
            : 'Describe what is in this photo.';

        const { llm } = useSettings.getState().settings;
        const answer = await complete({ ...llm, model: llm.visionModel || llm.model }, [
          {
            id: uid('m'),
            role: 'user',
            content: question,
            timestamp: Date.now(),
            images: [photo.dataUrl],
          },
        ]);

        return ok(answer.trim(), { image: photo.dataUrl });
      },
    }),

    defineTool({
      name: 'open_url',
      description: 'Open a web page in the in-app browser.',
      capability: 'browser',
      risk: 'low',
      platforms: MOBILE,
      parameters: { url: p.string('The URL to open.') },
      required: ['url'],
      async run(args) {
        const url = argString(args, 'url');
        if (!/^https?:\/\//i.test(url)) return fail('Only http and https URLs can be opened.');
        await Browser.open({ url, presentationStyle: 'popover' });
        return `Opened ${url}.`;
      },
    }),

    defineTool({
      name: 'read_file',
      description:
        "Read a text file from ARIA's storage. Only files ARIA itself created are " +
        'accessible — the OS sandboxes everything else.',
      capability: 'files',
      risk: 'low',
      platforms: MOBILE,
      parameters: { path: p.string('File path, relative to ARIA storage.') },
      required: ['path'],
      async run(args) {
        const path = argString(args, 'path');
        const result = await Filesystem.readFile({
          path,
          directory: ROOT,
          encoding: Encoding.UTF8,
        });
        return ok(String(result.data), { path });
      },
    }),

    defineTool({
      name: 'write_file',
      description: "Write a text file into ARIA's storage.",
      capability: 'files',
      risk: 'medium',
      destructive: true,
      platforms: MOBILE,
      parameters: {
        path: p.string('File path, relative to ARIA storage.'),
        content: p.string('The file contents.'),
      },
      required: ['path', 'content'],
      async run(args) {
        const path = argString(args, 'path');
        await Filesystem.writeFile({
          path,
          data: argString(args, 'content'),
          directory: ROOT,
          encoding: Encoding.UTF8,
          recursive: true,
        });
        return `Wrote ${path}.`;
      },
    }),

    defineTool({
      name: 'list_files',
      description: "List the files in ARIA's storage.",
      capability: 'files',
      risk: 'low',
      platforms: MOBILE,
      parameters: { path: p.string('Directory path. Defaults to the storage root.') },
      async run(args) {
        const path = args.path != null ? argString(args, 'path') : '';
        const result = await Filesystem.readdir({ path, directory: ROOT });
        if (result.files.length === 0) return 'No files.';

        const lines = result.files.map((f) =>
          f.type === 'directory' ? `  ${f.name}/` : `  ${f.name} (${formatBytes(f.size)})`,
        );
        return ok(lines.join('\n'), { files: result.files });
      },
    }),

    defineTool({
      name: 'delete_file',
      description: "Delete a file from ARIA's storage. This is immediate and cannot be undone.",
      capability: 'files',
      risk: 'high',
      destructive: true,
      platforms: MOBILE,
      parameters: { path: p.string('File path.') },
      required: ['path'],
      async run(args) {
        const path = argString(args, 'path');
        await Filesystem.deleteFile({ path, directory: ROOT });
        return `Deleted ${path}.`;
      },
    }),

    defineTool({
      name: 'share_text',
      description: 'Open the native share sheet with some text.',
      capability: 'files',
      risk: 'low',
      platforms: MOBILE,
      parameters: {
        text: p.string('The text to share.'),
        title: p.string('Optional title for the share sheet.'),
      },
      required: ['text'],
      async run(args) {
        await Share.share({
          text: argString(args, 'text'),
          title: args.title != null ? argString(args, 'title') : 'Shared from ARIA',
          dialogTitle: 'Share',
        });
        return 'Opened the share sheet.';
      },
    }),

    defineTool({
      name: 'share_file',
      description: "Share a file from ARIA's storage through the native share sheet.",
      capability: 'files',
      risk: 'low',
      platforms: MOBILE,
      parameters: { path: p.string('File path.') },
      required: ['path'],
      async run(args) {
        const path = argString(args, 'path');
        // The share sheet needs a real filesystem URI, not a relative path.
        const uri = await Filesystem.getUri({ path, directory: ROOT });
        await Share.share({ url: uri.uri, dialogTitle: 'Share' });
        return `Shared ${path}.`;
      },
    }),

    defineTool({
      name: 'send_notification',
      description: 'Show a notification on this device.',
      capability: 'notifications',
      risk: 'low',
      platforms: MOBILE,
      parameters: {
        title: p.string('Notification title.'),
        body: p.string('Notification body.'),
      },
      required: ['title', 'body'],
      async run(args) {
        if (!(await ensureNotificationPermission())) {
          return fail('Notification permission was denied.');
        }
        await LocalNotifications.schedule({
          notifications: [
            {
              id: Date.now() % 2_147_483_647,
              title: argString(args, 'title'),
              body: argString(args, 'body'),
              schedule: { at: new Date(Date.now() + 200) },
            },
          ],
        });
        return 'Notification sent.';
      },
    }),

    defineTool({
      name: 'set_reminder',
      description:
        'Schedule a reminder notification at a specific time. Pass an ISO 8601 timestamp.',
      capability: 'notifications',
      risk: 'low',
      platforms: MOBILE,
      parameters: {
        text: p.string('What to be reminded about.'),
        datetime: p.string('When, as an ISO 8601 timestamp.'),
      },
      required: ['text', 'datetime'],
      async run(args) {
        if (!(await ensureNotificationPermission())) {
          return fail('Notification permission was denied.');
        }

        const when = new Date(argString(args, 'datetime'));
        if (Number.isNaN(when.getTime())) return fail('That is not a valid date and time.');
        if (when.getTime() <= Date.now()) return fail('That time is in the past.');

        await LocalNotifications.schedule({
          notifications: [
            {
              id: Date.now() % 2_147_483_647,
              title: 'ARIA reminder',
              body: argString(args, 'text'),
              schedule: { at: when },
            },
          ],
        });
        return `Reminder set for ${when.toLocaleString()}.`;
      },
    }),

    defineTool({
      name: 'get_clipboard',
      description: 'Read the clipboard.',
      capability: 'system',
      risk: 'low',
      platforms: MOBILE,
      parameters: {},
      async run() {
        const { value } = await Clipboard.read();
        return value || 'The clipboard is empty.';
      },
    }),

    defineTool({
      name: 'set_clipboard',
      description: 'Copy text to the clipboard.',
      capability: 'system',
      risk: 'low',
      platforms: MOBILE,
      parameters: { text: p.string('Text to copy.') },
      required: ['text'],
      async run(args) {
        await Clipboard.write({ string: argString(args, 'text') });
        return 'Copied.';
      },
    }),

    defineTool({
      name: 'get_network_status',
      description: 'Check whether the device is online and on what kind of connection.',
      capability: 'network',
      risk: 'low',
      platforms: MOBILE,
      parameters: {},
      async run() {
        const status = await Network.getStatus();
        return status.connected
          ? `Connected over ${status.connectionType}.`
          : 'The device is offline.';
      },
    }),

    defineTool({
      name: 'get_device_info',
      description: 'Get the device model, OS version and battery level.',
      capability: 'system',
      risk: 'low',
      platforms: MOBILE,
      parameters: {},
      async run() {
        const info = await Device.getInfo();
        const battery = await Device.getBatteryInfo();
        const pct =
          battery.batteryLevel != null ? `${Math.round(battery.batteryLevel * 100)}%` : 'unknown';

        return [
          `Device: ${info.manufacturer ?? ''} ${info.model ?? ''}`.trim(),
          `OS: ${info.operatingSystem} ${info.osVersion}`,
          `Battery: ${pct}${battery.isCharging ? ' (charging)' : ''}`,
        ].join('\n');
      },
    }),

    defineTool({
      name: 'read_page',
      description:
        'Fetch a URL and return its readable text. Use this rather than open_url when you ' +
        'need to read the content yourself.',
      capability: 'network',
      risk: 'low',
      platforms: MOBILE,
      parameters: { url: p.string('The URL to read.') },
      required: ['url'],
      async run(args) {
        const url = argString(args, 'url');
        if (!/^https?:\/\//i.test(url)) return fail('Only http and https URLs can be read.');

        const res = await httpGet(url);
        if (!res.ok) return fail(`The page returned HTTP ${res.status}.`);

        const { title, text } = extractReadableText(res.body);
        const capped = text.length > 10_000 ? `${text.slice(0, 10_000)}\n… [truncated]` : text;
        return ok(`${title}\n\n${capped}`, { title, url });
      },
    }),

    defineTool({
      name: 'vibrate',
      description: 'Give haptic feedback.',
      capability: 'system',
      risk: 'low',
      platforms: MOBILE,
      parameters: {
        duration: p.integer('Milliseconds to vibrate. Defaults to 300.'),
      },
      async run(args) {
        const { Haptics } = await import('@capacitor/haptics');
        await Haptics.vibrate({
          duration: args.duration != null ? argNumber(args, 'duration') : 300,
        });
        return 'Done.';
      },
    }),
  ];
}
