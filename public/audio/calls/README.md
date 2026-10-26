# Fixed office announcement assets

This directory is reserved for 15 fixed office announcements: five employees ×
the three approved administrator offices. They are intentionally **not generated
yet**, pending approval of the first real voice sample.

These assets are public files shipped with the website. Only fixed staff/office
phrases belong here. Never put dynamic meeting titles, customer information,
credentials, or private recordings in this directory. Dynamic announcements are
stored in IndexedDB on the display computer instead.

The filename is the server's immutable SHA-256 speech key:

```text
public/audio/calls/<sha256>.wav
```

The key includes the final normalized text, model, voice, and speech settings
version. Changing a voice or configuration creates new files and preserves all
previous versions. The script does not delete or overwrite existing WAV files.

## Review without using Groq

```powershell
npm run warm:call-audio -- --dry-run
```

The dry run reads no `.env.local` key, writes no files, and contacts no service.
It reports only hit, miss, failure, and byte counts. Its voice/configuration use
the current process values, or the safe default `fahad` settings.

## Generate only after voice approval

Put `GROQ_API_KEY` in the ignored `.env.local` at the project root. Select the
approved voice with `GROQ_VOICE` (`fahad`, `sultan`, or `abdullah`). Then explicitly
provide both safety flags:

```powershell
npm run warm:call-audio -- --confirm-provider-calls --approve-all-15
```

Valid existing files are reused without a provider request. Missing files are
generated sequentially, validated as WAV, and written atomically with create-only
semantics. An invalid existing file is preserved and counted as a failure for
manual review. Generation does not publish or deploy the website.
