# pi-cleanre-workflow

Purpose: Operate separate rootless Pi research and implementation workers with reviewed transfers.

This extension reduces accidental filesystem and conversation exposure. Containers share the host kernel. They do not certify legal clean-room status or constrain a malicious account owner. Cloud inference is authorized egress: keeping credentials on the host does not keep prompts confidential. Model IDs do not make cloud responses reproducible.

## Build and validate

Pi SDK and adapter versions are 0.87.1 and 0.1.0. Dependencies are pinned in package-lock.json. Build using an explicitly reviewed Node 22 image digest:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
podman build --build-arg BASE_IMAGE=docker.io/library/node@sha256:REVIEWED_DIGEST -t localhost/cleanre-worker:dev -f Containerfile .
podman image inspect localhost/cleanre-worker:dev --format '{{.Id}}'
CLEANRE_TEST_IMAGE=sha256:IMAGE_ID npm test
```

Image builds need network for npm and Debian Git packages. The final immutable image ID pins the resolved build output; apt package resolution itself is not reproducible. Runtime never pulls images. Host Podman and util-linux flock must be on PATH. Rootless user namespaces and cgroup v2 memory/PID controllers are required. CPU quota is optional and deliberately not enforced. Nix can provide tools but cannot grant kernel permissions. No sudo, NixOS modification, host networking fallback, host container socket, or Pi home mount is supplied.

The optional real integration test uses a fake provider, not cloud credentials. It starts the whole Pi worker, attaches a separate terminal process, sends synthetic input, receives inference via the broker, checks protected mount/network/resource invariants, and removes the worker.

## Human workflow

Load with `pi -e ./src/extension.ts`; this changes no Pi settings.

`/cleanre doctor` checks rootless Podman and required memory/PID controllers.

`/cleanre init` creates controller-owned project state under `~/.local/state/pi-cleanre-workflow/`, outside Pi session branches.

Select the intended host model, then `/cleanre configure sha256:IMAGE_ID`. Configuration inspects the prefetched image, verifies embedded worker resource hashes, and saves cleanre-lock.json with image identity, Pi/adapter versions, resource hashes and approved model metadata. No upstream URLs, headers, auth.json, models.json, credential commands, or host extensions enter the worker catalog.

`/cleanre ingest /absolute/file` copies a legally supplied original into hash-addressed research-only storage, up to 64 MiB per file. Repeat for additional files. Implementation never receives this storage.

`/cleanre start research` runs a fresh whole-worker Pi session. Startup requires the approved provider/model and a successful actual-image probe of UID, network namespace, read-only mounts, memory/PID limits, and a private Unix socket. Confirm cloud inference permission. Each run gets separate state, workspace/Git metadata, input snapshot, cache, sessions and tmpfs. The host controller shows only status and attachment instructions. Open `podman attach NAME` in another terminal for detailed worker interaction. The worker is already ready before `/cleanre start` reports success; type input after the attach prompt appears. Do not rely on startup output being replayed by attach. `/quit` exits; `/cleanre stop` performs controller cleanup.

Create behavioral JSON in the research workspace and use `/cleanre export /absolute/workspace/export.json` to capture it into quarantine. This is a direct human command, not model authority.

`/cleanre review HASH` prints the exact read-only quarantine path for external full-file review. Read every byte and provenance statement in an external viewer, then type the exact hash to approve. The controller does not display raw candidate prose in its model transcript. Scanners/schema checks are not proof of confidentiality or provenance.

`/cleanre verify HASH` checks canonical content and SHA-256. `/cleanre start implementation` copies verified approved snapshots into a fresh read-only input directory; it never mounts the live approval store. Stop research first. Implementation starts a new Pi session and empty workspace, with no inherited research summary or transcript.

Only one active phase is allowed per controller. A project lease excludes concurrent controllers. Write-ahead container intent and verified labels/IDs support orphan cleanup after a crash; a restarted controller stops dead-broker workers instead of adopting their conversations. An OS-held flock lease blocks takeover and releases when controller stdin closes on death. Ambiguous/corrupt ownership refuses cleanup.

## Candidate format

```json
{"schema":1,"behavior":"Reviewed behavior","fixtures":["Fixed input and output"],"provenance":["Reviewed source and rights basis"]}
```

Export rejects invalid UTF-8, invalid JSON, unknown fields, missing provenance, links and nonregular files. Both input and canonical output are limited to 256 KiB. JSON is canonicalized before hashing; duplicate-key discarded bytes are never transferred. Approvals bind the exact canonical bytes. Existing snapshots are never overwritten. Read-only permissions and hashes do not protect against a malicious host account owner.

## Broker limits

Each worker has one project/phase/model capability, concurrency one, at most 100 requests, 4096 output tokens per request, 1 MiB request bodies, 16 MiB response stream and 120-second request timeout. A $1 conservative catalog reservation ceiling applies per run, not across restarts. This is not a provider billing guarantee. The broker validates transcript message unions and only accepts exact assistant messages issued during its lifetime, including opaque native replay signatures. Unknown metadata and native file/reference input blocks are rejected. The broker does not execute tools, accept arbitrary endpoints, or retrieve transcripts. Host provider extensions are trusted code. Existing host environment credentials remain in Pi; restart Pi/broker when agenix environment changes.

Provider OAuth refresh, custom provider edge cases, images and cloud inference require separate verification. Basic fake-provider inference and real rootless transport are tested. Manual terminal usability and independent security review remain required. Large candidate review is an external human step, not an automatic or model-only approval.

Probe ownership is journaled before launch and recovered after controller SIGKILL. Quarantine and approval publication sync the containing directory before acknowledgment. Worker terminal error events are displayed instead of silently returning to the prompt.
