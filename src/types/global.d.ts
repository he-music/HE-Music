import { MessageApi, DialogApi, NotificationApi, LoadingBarApi, ModalApi } from "naive-ui";

type Player = typeof import("@/utils/player").default;
declare global {
  interface Navigator {
    userAgentData?: {
      brands: Array<{ brand: string; version: string }>;
      getHighEntropyValues(hints: string[]): Promise<{ model?: string }>;
    };
  }
  interface Window {
    player?: null | Player;
    $player?: null | Player;
    // naiveui
    $message: MessageApi;
    $dialog: DialogApi;
    $notification: NotificationApi;
    $loadingBar: LoadingBarApi;
    $modal: ModalApi;
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
