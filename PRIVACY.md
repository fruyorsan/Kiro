# Privacy policy

Kiro has no telemetry. There is no analytics service, no crash reporter, no
account, no advertising identifier and no "phone home" call. The project has no
server of its own, and the source code is public so every claim here can be
checked.

This page describes the only network requests the app can make, and what stays on
your machine.

## What stays on your machine

Everything under the app's configuration directory, which is
`%APPDATA%\com.kiro.app` on Windows and `~/.config/com.kiro.app` on Linux:

- `settings.json` — your preferences, including **API keys you entered yourself**.
  Keys are stored in this file in plain text, so treat the file like any other
  credential file.
- `pinned_apps.json`, `custom_icons/` — your dock.
- The calendar cache, notes, the shelf's temporary files and the log.

Uninstalling Kiro does not send anything anywhere. Delete the directory and the
data is gone.

## Network requests Kiro can make

Each one happens only because of a feature you turned on or an action you took.

| When | Where | What is sent |
| --- | --- | --- |
| You ask the notch AI a question | `api.anthropic.com`, `api.openai.com` or `generativelanguage.googleapis.com`, whichever provider you selected | Your prompt, any images you attached, the conversation context and **your own API key** |
| Weather is on | `api.open-meteo.com` | An approximate location (coordinates) |
| Weather is on and you have not set a city | `ipapi.co`, `freeipapi.com`, `ipwho.is`, `get.geojs.io` | Your IP address, to estimate a city. Only one of these is tried, and only to fill in the location |
| You search a city for weather or a second clock | `geocoding-api.open-meteo.com` | The text you typed |
| You add a calendar | The ICS or CalDAV address **you** supplied (Google, iCloud, Outlook, Proton, Nextcloud, your own server) | A standard calendar request, with your credentials if you set an account |
| Kiro checks for updates | `api.github.com` | A request for the public release list. No identifier is attached |

Nothing else is contacted. There is no background upload, no usage statistics and
no diagnostic submission: **Settings › About › Copy Diagnostics** puts a report on
your clipboard and lets you paste it into a bug report yourself, if you choose to.

## Third parties

Third-party services you configure are governed by their own policies: Anthropic,
OpenAI, Google, Open-Meteo, your calendar provider and GitHub. Kiro only talks to
them on your behalf with the credentials you provided.

The **Claude Code CLI** option is different: Kiro runs the `claude` command that is
already installed and logged in on your machine, and that program's own terms and
privacy policy apply.

## Children

Kiro is a desktop customisation tool with no user accounts and no data collection.
It is not directed at children and it does not knowingly receive personal data
from anyone, because it collects none.

## Changes

This policy is part of the repository, so every change is visible in the commit
history of `PRIVACY.md`.

## Contact

Questions or a correction: open an issue at
<https://github.com/fruyorsan/Kiro/issues> or email **furknn.jpg@gmail.com**.
