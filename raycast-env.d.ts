/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Audio Folder - The folder containing your audio files (subfolders become categories). */
  "audioFolder": string,
  /** After Effects Binary - Full path to the AE executable (used with -r). Default: /Applications/Adobe After Effects 2025/Adobe After Effects 2025.app/Contents/MacOS/After Effects */
  "aeBinaryPath"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `browse-audio-files` command */
  export type BrowseAudioFiles = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `browse-audio-files` command */
  export type BrowseAudioFiles = {}
}

