import { Howl } from "howler";
import { MessageApi, DialogApi, NotificationApi, LoadingBarApi, ModalApi } from "naive-ui";

type Player = typeof import("@/utils/player").default;
declare global {
  interface Window {
    player?: null | Howl;
    $player?: null | Player;
    // naiveui
    $message: MessageApi;
    $dialog: DialogApi;
    $notification: NotificationApi;
    $loadingBar: LoadingBarApi;
    $modal: ModalApi;
    // electron
    api: {
      store: {
        get: (key: string) => Promise<any>;
        set: (key: string, value: unknown) => Promise<boolean>;
        has: (key: string) => Promise<boolean>;
        delete: (key: string) => Promise<boolean>;
        reset: (keys?: string[]) => Promise<boolean>;
        export: (data: any) => Promise<boolean>;
        import: () => Promise<any>;
      };
    };
    queryLocalFonts?: () => Promise<FontData[]>;
  }
}

interface FontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}

interface FontStyleSelection {
  family: string;
  weight: number;
  style: string;
  postscriptName: string;
}
