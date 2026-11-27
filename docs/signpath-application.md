# SignPath Foundation application

Everything needed to apply for the free code-signing subscription at
<https://signpath.org/apply>, plus what to do once it is approved. The technical
steps live in [SIGNING.md](SIGNING.md); this file is the paperwork.

Apply **before** the README or the release notes claim that Kiro is signed. The
Foundation requires the download page to state that the project uses them for code
signing, and the honest order is: approval, signing step in CI, first signed build,
then the wording switches to "signed".

## Form fields

| Field | Value |
| --- | --- |
| Project name | `Kiro` |
| Homepage URL * | `https://github.com/fruyorsan/Kiro` |
| Download URL | `https://github.com/fruyorsan/Kiro/releases` |
| Privacy Policy URL | `https://github.com/fruyorsan/Kiro/blob/main/PRIVACY.md` |
| Wikipedia URL | leave empty |
| Tagline * | `A Windows desktop shell: a dynamic-island notch, a dock, seasonal themes, AI in the notch, and a game layer that steps aside.` |
| Category * | `Other` — the list has no desktop/shell category (Accessibility, Audio, Developer tools, Educational, Gaming, Graphics, Productivity, Science, Other). |
| Maintainer Type | `Individual` |
| Build System * | `GitHub Actions` |
| First Name / Last Name * | the name for the SignPath account, e.g. `Furkan` / `Akkose` |
| Email * | `furknn.jpg@gmail.com` — the address in `COMMERCIAL.md`. **Not** `fruyorsan@users.noreply.github.com`: commit addresses are a privacy alias, not a mailbox, and the approval mail has to arrive somewhere. |
| Company Name | leave empty — the project is maintained by one person, not a company. |
| Primary Discovery Channel * | answer honestly. The options are roughly: search engine, AI assistant, GitHub repository, Reddit, blog article, conference, other. If it was another project's release notes or README that mentioned SignPath, that is "GitHub repository". |
| Please specify the exact source | the query you used, the project you saw it in, or the URL. Optional, but a specific answer reads better than none. |

## Description

> Kiro is a desktop shell for Windows 10 and 11. It replaces the taskbar with two
> pieces of furniture: a dynamic-island style notch that holds music, system
> controls, a calendar, notes and a file shelf, and a dock that mirrors the apps
> the user actually runs. It is themed rather than skinned: four surface styles
> and four seasonal effects that can follow the calendar, with the accent colour,
> opacity and mascot under the user's control. AI lives in the notch — Claude,
> ChatGPT and Gemini answer there, and a coding agent running in a terminal can
> report its state to the notch, so the user sees when it needs input. A
> performance layer steps aside at the OS level when a fullscreen game starts, so
> the game keeps its direct-to-screen flip. GPLv3, no telemetry, no account, no
> paid tier. Also on Linux.

## Reputation

> First release 7 November 2026: 15 releases in 19 days on a weekly cadence, all
> built and published by GitHub Actions. GitHub's release counters show 975 asset
> downloads in that period, including 492 Windows installers and portable builds
> and 29 Linux packages; the updater manifest alone is fetched over 400 times,
> which is installed copies checking for updates. The repository has 10 stars and
> 3 open issues from users. Kiro is distributed directly through GitHub releases
> and has no press coverage yet.

Reputation is the weakest field on the form: the project is three weeks old. The
numbers above are the real ones, and they are the honest best case — do not inflate
them. If the application is rejected, the reply usually says why, and the same form
can be sent again once winget and a few thousand installs exist.

## Build system

> GitHub Actions. `.github/workflows/release.yml` builds the Windows NSIS installer
> and the Linux AppImage and `.deb` with `tauri build`, then publishes them to the
> GitHub release for the tag. Windows artifacts are unsigned today; the AppImage
> and `.deb` carry a Tauri updater signature (minisign), which is a different thing
> and does not affect SmartScreen.

## What needs signing, and why

> The Windows artifacts: `Kiro_<version>_x64-setup.exe` (the NSIS installer) and
> the `Kiro.exe` it contains. Without Authenticode, Windows SmartScreen shows
> "unknown publisher" on every install, and a program that replaces the taskbar is
> exactly the kind of software users are told to be suspicious of, so the warning
> costs real installs. Linux builds do not need signing.

## Anything else we should know

> The project is a fork-friendly GPLv3 codebase; part of the Windows shell
> integration is adapted from two other GPLv3 projects (Bloom and Nectar), and
> their notices are kept in `NOTICE.md`. There is no proprietary version: every
> feature ships in the GPLv3 build, and there is no paid tier.

## If they ask about the commercial licence in `COMMERCIAL.md`

> The commercial licence exists only for cases the GPLv3 cannot serve — bundling
> Kiro's code inside a closed-source product, OEM/white-label builds and managed
> deployment. It is not a paid edition of the app: there is one build, it is the
> GPLv3 one, and it is what we ask to have signed.

## Before submitting

The Download URL has to be a page that says the project uses the SignPath
Foundation for code signing. Two places carry that sentence: the "Code signing"
paragraph in `README.md` (the homepage) and the footer the release workflow appends
to every release note (the releases page). Both say that signing is still being set
up, which is true until the first signed build ships.

Push those two changes before submitting: the reviewer reads the live pages, not the
local files.

## After approval

1. In the SignPath dashboard create a project for the repository, a signing policy
   (`release-signing`) and artifact configurations for `Kiro.exe` and
   `*-setup.exe`.
2. Add `SIGNPATH_API_TOKEN` as a repository secret, and the organization/project/
   policy/artifact IDs as secrets or variables.
3. Add the signing step to `.github/workflows/release.yml` before `tauri-action`
   publishes, following the order in [SIGNING.md](SIGNING.md): build, sign,
   regenerate the updater `.sig`, then publish. Signing after the `.sig` was
   generated breaks every installed copy with `signature verification failed`.
4. Verify the first signed build:

   ```powershell
   Get-AuthenticodeSignature .\Kiro_<version>_x64-setup.exe | Format-List Status, SignerCertificate
   ```

   `Status` must be `Valid`.
5. Only then change the claim in two places:
   - the "Code signing" paragraph in `README.md`
   - the `SIGNING=` line in `.github/workflows/release.yml`, which currently says
     that signing is being set up
6. Update the antivirus section of `README.md` and the VirusTotal block, as noted
   at the end of [SIGNING.md](SIGNING.md).
