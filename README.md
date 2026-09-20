# Appium Inspector Bridge

[日本語版 README](README.ja.md)

An unofficial VS Code extension that embeds the official Appium Inspector web UI in an editor tab. It uses the official Inspector UI exclusively rather than maintaining a separate inspector implementation.

## Features

- Open the official Appium Inspector plugin inside VS Code.
- Install the Inspector plugin, start or stop a local Appium Server, and view its logs.
- Check the local Appium version, Inspector plugin, and installed drivers before starting a server.
- Offer guided remediation from Environment Check, including Appium installation, Inspector plugin installation, and driver installation commands.
- Show connection status and reconnect without creating a new session.
- Open multiple independent Inspector tabs, automatically placing additional tabs beside the first for side-by-side Android and iOS sessions.
- List Android devices and iOS simulators, then generate a capability JSON template.
- Persist official Inspector capability sets, connection details, theme, language, and saved gestures in VS Code SecretStorage.
- Bridge copy and paste between the official Inspector iframe and VS Code, including Selected Element values.
- Show the extension UI in English or Japanese according to the VS Code display language.

## Requirements

- Appium 3 and the driver required by your target platform.
- The official Appium Inspector plugin: `appium plugin install inspector`.
- A desktop VS Code instance that can reach a local HTTP server (`localhost`, `127.0.0.1`, or `::1`). Remote SSH, browser VS Code, and automatic container forwarding are not supported.

Start VS Code from an environment where `appium` is available on `PATH`. On Windows, start Appium externally and use **Open Running Inspector** because npm `.cmd` launcher support is unavailable.

## Quick start

1. Open **Appium Inspector** from the Activity Bar, or press `⌘⌥A` (`Ctrl+Alt+A` on Windows/Linux).
2. Under **Initial Setup**, select **Install Official Plugin** if needed.
3. Select **Start and Open Official Inspector**. The extension starts Appium with `--use-plugins=inspector` and opens `/inspector` in an editor tab.
4. Configure capabilities and create or end sessions in the official Inspector UI.

To use an existing server, select **Open Running Inspector**. If the server was started without the plugin, stop it at its original source and restart it with `--use-plugins=inspector`. The Inspector UI is always at `/inspector`, even when Appium uses a base path such as `/wd/hub`; configure that real base path in the official Inspector's Server Details.

## Devices and capabilities

Open **Devices & Capabilities** and select **Refresh Devices**. The extension lists ready Android devices and available iOS simulators, then generates a JSON template with `platformName`, `appium:automationName`, `appium:udid`, and `appium:deviceName`.

Copy the template and paste it into the official Inspector JSON Representation editor. Add the target application details as needed:

- Android: `appium:app`, `appium:appPackage`, and `appium:appActivity`
- iOS: `appium:app` or `appium:bundleId`

Android uses `adb devices -l`; configure `PATH`, `ANDROID_HOME`, or `ANDROID_SDK_ROOT` if needed. iOS simulator listing uses `xcrun simctl` on macOS. No device is started and no application is installed by this feature.

## Settings and safety

The official Inspector's saved capability sets, preferences, saved gestures, and server details are saved per Server URL in VS Code SecretStorage. Save capability sets with **Save As** in the official UI, then select them from **Saved Capability Sets** later. Unsaved edits and active sessions are not restored.

Stopping a server or reloading Inspector requires confirmation. Reloading does not end the server-side session; save what you need and end the session in the official UI first. The connection monitor only checks server reachability and does not guarantee device or session health.

The extension does not bundle Appium Inspector. Its available features follow the installed official plugin version. This is not an Appium team product. The official plugin is Apache-2.0; this extension is MIT licensed.
