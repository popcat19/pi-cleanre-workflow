# Repo context

Purpose: Identify the clean-room workflow development boundaries and verification entry points.

## Vocabulary

The workflow is the domain. `src/transfer.ts` owns the artifact transfer policy. `src/extension.ts` is the controller boundary. Broker and worker transport are separate supporting domains. Each research/implementation worker is a bounded context with no shared writable state. SHA-256 artifact IDs are value objects; human approval is controller-owned authority. The controller is the aggregate root for policy and lifecycle state.

## Entry points

`README.md` records supported commands and runtime requirements. `src/worker.ts` starts the isolated no-discovery Pi process. `Containerfile` builds the worker image from a reviewed digest. `test/boundaries.test.ts` and `test/broker.test.ts` exercise filesystem, OCI planning and transport contracts. `package.json` declares the local extension and pinned development SDK; `package-lock.json` records dependency resolution.
