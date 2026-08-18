import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'ai.jarvis.assistant',
  appName: 'Jarvis',
  webDir: 'dist',

  server: {
    androidScheme: 'https',
  },

  android: {
    // Jarvis is dark-only; a light webview background flashes white on launch.
    backgroundColor: '#05080d',
    allowMixedContent: false,
    captureInput: true,
  },

  ios: {
    backgroundColor: '#05080d',
    contentInset: 'never',
    // The app draws its own safe-area padding via CSS env().
    scrollEnabled: false,
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#05080d',
      showSpinner: false,
      androidSplashResourceName: 'splash',
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_jarvis',
      iconColor: '#2ad4ff',
    },
    Keyboard: {
      resize: KeyboardResize.Body,
      style: KeyboardStyle.Dark,
      resizeOnFullScreen: true,
    },
    CapacitorHttp: {
      // Route fetch through the native layer so third-party pages are not
      // blocked by CORS.
      enabled: true,
    },
  },
};

export default config;
