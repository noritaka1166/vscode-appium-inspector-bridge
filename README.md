# Appium Inspector Bridge

[日本語版 README](README.ja.md)

An unofficial VS Code extension that embeds the official Appium Inspector web UI in an editor tab. It uses the official Inspector UI exclusively rather than maintaining a separate inspector implementation.

![Appium Inspector Bridge running inside VS Code](media/inspector-hero.png)

## Features

- Open the official Appium Inspector plugin inside VS Code.
- Install the Inspector plugin, start or stop a local Appium Server, and view its logs.
- Check the local Appium version, Inspector plugin, and installed drivers before starting a server.
- Offer guided remediation from Environment Check, including Appium installation, Inspector plugin installation, and driver installation commands.
- Show connection status and reconnect without creating a new session.
- Open multiple independent Inspector tabs, automatically placing additional tabs beside the first for side-by-side Android and iOS sessions.
- List running sessions on the selected Appium Server and attach one in a new Inspector tab.
- List Android devices and iOS simulators, then generate a capability JSON template.
- Persist official Inspector capability sets, connection details, theme, language, and saved gestures in VS Code SecretStorage.
- Bridge copy and paste between the official Inspector iframe and VS Code, including Selected Element values.
- Show the extension UI in English or Japanese according to the VS Code display language.

## Requirements

### Required for every platform

- Desktop VS Code. The extension connects only to local loopback servers (`localhost`, `127.0.0.1`, or `::1`); Remote SSH, browser VS Code, and automatic container forwarding are not supported.
- A supported Node.js version and npm 10 or later. Appium 3 supports Node.js `^20.19.0`, `^22.12.0`, or `>=24.0.0`; an active LTS release is recommended. Start VS Code from an environment where both `node` and `npm` are available on `PATH`.
- Appium 3, the official Inspector plugin, and an Appium driver for the platform you intend to inspect.

The extension checks these Appium components and can install Appium 3 and the official Inspector plugin from **Initial Setup** after confirmation. It does not bundle them in the VSIX, so they remain compatible with your Node.js installation and can be updated independently.

### Android

- Android SDK Platform-Tools, including `adb` on `PATH` (or configured with `ANDROID_HOME` / `ANDROID_SDK_ROOT`).
- A connected Android device or a running Android emulator.
- The UiAutomator2 driver: `appium driver install uiautomator2`.

### iOS

- macOS with Xcode and Xcode Command Line Tools installed.
- An available iOS Simulator, or an iOS device configured for Xcode development and code signing.
- The XCUITest driver: `appium driver install xcuitest`.

The extension can list iOS simulators through `xcrun simctl`, but it cannot bundle Xcode, the Android SDK, device images, or signing credentials. Install those platform tools before creating a session.

On Windows, the extension supports the npm `.cmd` launchers used by standard Node.js installations.

## Quick start

1. Open **Appium Inspector** from the Activity Bar, or press `⌘⌥A` (`Ctrl+Alt+A` on Windows/Linux).
2. Under **Initial Setup**, select **Install Official Plugin** if needed.
3. Select **Start and Open Official Inspector**. The extension starts Appium with `--use-plugins=inspector` and session discovery enabled, then opens `/inspector` in an editor tab.
4. Configure capabilities and create or end sessions in the official Inspector UI.

To use an existing server, select **Open Running Inspector**. If the server was started without the plugin, stop it at its original source and restart it with `--use-plugins=inspector`. The Inspector UI is always at `/inspector`, even when Appium uses a base path such as `/wd/hub`; configure that real base path in the official Inspector's Server Details.

### Attach to a running session

Open **Running Sessions** in the sidebar and select **Refresh Sessions**. Choose **Attach** for the target session to open a new Inspector tab. The bridge opens the official Inspector's Attach to Session flow with the target session ID; when an older Inspector version cannot automate that field, the ID remains in the clipboard for manual pasting.

Appium 3 protects the session list behind its `session_discovery` insecure feature. Servers started by this extension enable it only on the loopback interface. For an externally started local server, add `--allow-insecure=*:session_discovery` to its start command. This makes session metadata visible to local clients, so do not use it on an untrusted network interface.

## Devices and capabilities

Open **Devices & Capabilities** and select **Refresh Devices**. The extension lists ready Android devices and available iOS simulators, then generates a JSON template with `platformName`, `appium:automationName`, `appium:udid`, and `appium:deviceName`.

Copy the template and paste it into the official Inspector JSON Representation editor. Add the target application details as needed:

- Android: `appium:app`, `appium:appPackage`, and `appium:appActivity`
- iOS: `appium:app` or `appium:bundleId`

Android uses `adb devices -l`; configure `PATH`, `ANDROID_HOME`, or `ANDROID_SDK_ROOT` if needed. iOS simulator listing uses `xcrun simctl` on macOS. No device is started and no application is installed by this feature.

## Settings and safety

The official Inspector's saved capability sets, preferences, saved gestures, and server details are saved per Server URL in VS Code SecretStorage. Save capability sets with **Save As** in the official UI, then select them from **Saved Capability Sets** later. Unsaved edits and active sessions are not restored.

Stopping a server requires confirmation. The connection monitor only checks server reachability and does not guarantee device or session health.

The extension does not bundle Appium Inspector. Its available features follow the installed official plugin version. This is not an Appium team product. The official plugin is Apache-2.0; this extension is MIT licensed.
