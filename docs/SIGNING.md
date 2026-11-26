# Code signing

Kiro already ships **two different signatures**, and they solve different
problems. Keep both.

| Signature | What it proves | Where it lives |
| --- | --- | --- |
| **Tauri updater signature** (minisign) | The update came from us and was not modified in transit | `TAURI_SIGNING_PRIVATE_KEY`, `*.sig`, `latest.json` |
| **Windows Authenticode** (code signing certificate) | Publisher identity to Windows, SmartScreen and antivirus | the `.exe` itself |

The updater signature **does not** remove the SmartScreen "unknown publisher"
warning. Only Authenticode does. This document is about the second one.

## Order of operations

Authenticode signs bytes. If you sign an installer **after** Tauri generated its
`.sig`, the `.sig` no longer matches and every installed copy fails with
`signature verification failed`. The build therefore has to go:

```
tauri build  ->  sign Kiro.exe + *-setup.exe  ->  regenerate *.sig  ->  publish
```

`src-tauri/tauri.conf.json` keeps a single updater key; nothing about it changes
when Authenticode is added.

## Free option: SignPath Foundation

SignPath Foundation signs open-source projects for free, in the cloud, with no
hardware token. GPLv3 satisfies their licence requirement.

1. Apply at <https://signpath.org/apply> with the repository URL. Approval
   usually takes a few working days to two weeks.
2. In the SignPath dashboard create a **project** for the repository, one
   **signing policy** (`release-signing`), and **artifact configurations** for
   `Kiro.exe` and `*-setup.exe`.
3. Note the organization ID, project slug, signing policy slug and artifact
   configuration slug.
4. Add these repository secrets: `SIGNPATH_API_TOKEN`, and the IDs either as
   secrets or as repository variables.
5. Add the signing step to `.github/workflows/release.yml` **before**
   `tauri-action` publishes, i.e. run the build with `releaseDraft: true`, sign
   the produced files, refresh the signatures, then publish the draft.

The signing step looks like this (parameter names follow SignPath's
`github-action-submit-signing-request@v1`; check them against the dashboard when
you set it up):

```yaml
      - name: Sign the Windows artifacts
        if: matrix.target == 'windows'
        uses: signpath/github-action-submit-signing-request@v1
        with:
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
          organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
          project-slug: kiro
          signing-policy-slug: release-signing
          artifact-configuration-slug: kiro-windows
          input-artifact-path: src-tauri/target/release/bundle/nsis
          output-artifact-directory: signed
          wait-for-completion: true
```

Refreshing the updater signature after signing, with the same key, is one
command per artifact:

```bash
bunx @tauri-apps/cli signer sign signed/Kiro_1.2.3_x64-setup.exe
```

Replace the `.sig` next to the artifact and the `signature` field in
`latest.json` with the new value. `Verify the updater signature matches the
compiled-in key` in the release workflow is the check that catches a mistake
here before users see it.

## Verify a local build

```powershell
signtool verify /pa /v .\Kiro-Setup-1.2.3.exe
Get-AuthenticodeSignature .\Kiro-Setup-1.2.3.exe | Format-List *
```

A correctly signed file reports `Status : Valid` and a `SignerCertificate` whose
subject contains the publisher name. Timestamping (`/tr` with an RFC 3161 URL) is
part of the policy, so the signature stays valid after the certificate expires.

## The other options

| Option | Cost | Notes |
| --- | --- | --- |
| **SignPath Foundation** | free | Open source only. Best first step. |
| **Certum open-source certificate** | ~free, token may cost | Private key must live in a token or cloud HSM. |
| **Microsoft Store** | $19 once | Microsoft signs it, and the Store dashboard reports real installs. Check the policy for shell/taskbar replacements before paying. |
| **Azure Trusted Signing** | ~$10/month | Individual applicants are generally rejected; needs a company with history. |
| **OV certificate** | €200–400/year | SmartScreen reputation builds up over time. |
| **EV certificate** | €300–600/year | Reputation from day one. Most expensive, most certain. |

Do **not** ship a self-signed certificate. It looks worse than unsigned: Windows
shows the same warning plus an untrusted-root error.

## After the first signed release

Update the antivirus section of `README.md`: the "the installer is not code-signed
yet" paragraph is no longer true, and that paragraph is currently the biggest
trust problem the project has. Same for the VirusTotal `<details>` block.
