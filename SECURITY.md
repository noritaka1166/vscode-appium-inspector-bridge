# Security Policy

## Supported Versions

Security fixes are provided for the latest released version of Appium Inspector Lite. Older releases should be upgraded before reporting an issue whenever possible.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Earlier releases | No |

## Reporting a Vulnerability

Please do not report suspected vulnerabilities through public GitHub issues, discussions, or pull requests.

Use GitHub's **Private Security Advisory** feature for this repository. If private reporting is unavailable, contact the repository owner privately through GitHub and include a link to the affected repository and release.

Please include:

- A concise description of the issue and its security impact.
- The affected extension version, VS Code version, operating system, and Appium/Inspector versions.
- Clear, minimal steps to reproduce the behavior.
- Any proof of concept or logs needed to validate the report, with secrets, access tokens, device identifiers, and personal data removed.

Reports will be acknowledged as soon as reasonably possible. After validation, a fix, mitigation, or explanation of the risk assessment will be provided. Please allow time for a fix to be released before public disclosure.

## System and Scope

Appium Inspector Lite is a desktop VS Code extension that embeds the official Appium Inspector web UI and communicates only with local Appium servers. This policy covers the extension source, its loopback relay, Webview bridges, local device discovery, and Inspector settings stored by the extension.

The following components are outside this repository's security boundary and should be reported to their respective maintainers:

- Appium Server and Appium drivers.
- The official Appium Inspector plugin and its web UI.
- VS Code and its Electron runtime.
- Android SDK, Xcode, device firmware, and emulator/simulator runtimes.

## Threat Model and Trust Boundaries

The extension treats the following as security boundaries:

- The VS Code extension host and Webviews.
- The loopback-only Inspector relay and the configured local Appium Server.
- Messages exchanged between the official Inspector iframe and the VS Code Webview.
- Inspector preferences and capability sets stored in VS Code SecretStorage.
- Output from local tools such as `appium`, `adb`, and `xcrun`.

Appium URLs, Inspector HTML, device metadata, local command output, and iframe content can contain untrusted data. The extension must not treat them as trusted code or grant them access beyond the explicitly intended local integration.

## Security Invariants

- The embedded Inspector and relay accept only local HTTP Appium endpoints; remote hosts, credentials in URLs, and unsafe URL schemes must be rejected.
- The relay listens only on loopback and rejects cross-origin or unexpected-host requests.
- Webview bridge messages must require the current, unguessable relay token and validate their message source.
- Inspector settings are limited to approved localStorage keys, validated as JSON, size-bounded, and stored only in VS Code SecretStorage.
- Sensitive data must not be written to repository files or public logs by this extension.
- Commands that inspect local Appium or device environments run only in a trusted workspace.
- Stopping a managed Appium Server and reloading Inspector require user confirmation.

## Reportable Findings and Severity Context

Report issues that could realistically allow a website, iframe, local process, or malicious project content to:

- Access or modify Inspector settings, clipboard data, or capability sets without the user's intended action.
- Bypass relay origin, host, token, or local-endpoint restrictions.
- Execute commands or inject script in the VS Code extension host or Webview.
- Expose credentials or other sensitive data through logs, persistent files, or another extension context.
- Stop an Appium Server, alter a session, or otherwise perform a security-sensitive action without confirmation or authorization.

Severity depends on realistic exploitability, affected data or actions, and whether user interaction or local-machine access is required.

## Known Limitations

This extension is designed for local desktop VS Code use and does not support Remote SSH, browser VS Code, or automatic container forwarding. The connection monitor establishes server reachability only; it does not verify device or session health.

Capability sets and Inspector preferences can contain sensitive values. They are stored in VS Code SecretStorage, but users should remove unneeded saved sets and avoid placing secrets in public bug reports.
