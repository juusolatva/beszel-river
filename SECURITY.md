# Security Policy

## Supported Versions

Only the latest release, or the default branch if there are no releases, receives security fixes.

## Reporting a Vulnerability

Please do not report security vulnerabilities through public issues, pull requests, or discussions.

Report them privately through GitHub's private vulnerability reporting:

1. Go to the repository's Security tab.
2. Click Report a vulnerability.

If that option is unavailable, please contact me using the email address on my GitHub profile.

Please include:

- A description of the issue and its potential impact
- Steps to reproduce, or a proof of concept
- Affected version, commit, or configuration

## What to Expect

This is a personal project maintained on a best-effort basis. I aim to acknowledge reports within 7 days and will keep you updated on progress. Once a fix is released, you will be credited in the advisory unless you prefer to remain anonymous.

## System and Scope

Beszel River publishes an abstract animation driven by private Beszel metrics.
This policy covers the bridge, shared frame types, frontend, shipped deployment
configurations, dependencies as used here, and build and release workflows.
`docs/PLAN.md` describes the design; `README.md` describes supported deployments.

The page, assets and `GET /stream` are intentionally public and unauthenticated.
There is no public administration or mutation API. Health is private: container
deployments use a separate loopback listener; without Docker, the bridge binds
to loopback and the shipped nginx configurations do not proxy `/healthz`.
The host-network override shares the host's loopback, not an isolated container
network. The proxy-network override exposes the service to its shared network.

## Threat Model and Trust Boundaries

Public clients can choose request targets, methods, headers, connection counts
and read speeds, and record frames over time. They must not gain hub access,
private data, filesystem access or control of the service.

Operators control environment variables, the private recipe, the frontend build
directory, hub address and deployment configuration. Those are privileged inputs,
not public request parameters. The hub is the configured metrics authority;
malformed records still cross a parsing boundary. A finding involving a hostile
hub or agent must identify that prerequisite and the additional impact.

Protected assets include hub credentials, tokens, `STREAM_SALT`, the private
mixing recipe, raw metrics, host identities, service availability and release
integrity. The bridge should use a dedicated read-only hub account. Hub account
permissions depend on hub configuration and are not enforced by this project.
Logs are operator-facing, not a public API; they may identify the hub and account.

Untrusted pull-request content and dependencies cross a separate build boundary.
They must not acquire release credentials or influence privileged publication
through an unintended workflow, artifact or cache path.

## Security Invariants

- Public frames contain only the documented frame metadata and Stream fields.
  Raw metrics, hostnames, system IDs, Beszel field names, credentials, salt and
  recipe must not reach public responses or frontend assets. Channels are finite
  values in 0..1, rounded to three decimals; paused hosts are omitted.
- Stream IDs use the first eight hex characters of HMAC-SHA256 over the UTC date
  and system ID, domain-separated with `:stream`, using the private salt.
  IDs rotate daily. Band order and quantized widths are seeded daily; widths
  must not encode thread counts. These are pseudonyms, not authorization tokens.
- Filaments are absent when their recipe is omitted or null. Enabling them
  requires a complete valid recipe; output is six resampled, mixed, jittered
  and daily-reordered values, independent of the number of cores.
- A missing, unreadable or invalid recipe stops startup before listening or
  authenticating. There is no automatic fallback to the public example.
  Explicit example selection is for development or isolated smoke tests.
- Public requests must not select filesystem paths or upstream destinations.
  Static serving uses the validated build loaded at startup. Routing and proxy
  normalization must not bypass route restrictions or connection limits.
- SSE clients must have bounded resource use and reliable disconnect cleanup.
  Current bridge defaults are 500 streams, 256 KiB queued output per response
  and a 10-second drain timeout; blocked clients must not stall healthy clients
  or accumulate per-client frame histories.
- The public page uses same-origin resources and no inline scripts. Its CSP
  permits inline styles only; security headers must survive proxying and error
  responses in the supported deployment mode. Public TLS and HSTS belong to
  the reverse proxy.
- Real credentials and private recipes must stay out of version control, build
  contexts, published images and public artifacts. Release publication must
  remain restricted to authorized workflows and revisions.

## Reportable Findings and Severity Context

Report reachable violations of these boundaries, including unintended metric or
identity disclosure, credential exposure, injection, arbitrary file access,
unintended upstream requests, resource exhaustion and release compromise.
The public stream's lack of authentication is intentional; access to data beyond
its documented contract is not.

Severity follows demonstrated confidentiality, integrity or availability impact,
attacker prerequisites, affected deployment modes and realistic scale. Distinguish
a public exploit from one requiring privileged configuration or prior compromise.
No finding class or dependency is categorically exempt. Identify the affected
control and reachable path rather than treating a missing hardening option alone
as an exploit. Tests indicate intended behavior, not proof of security.

## Accepted Privacy Limits

One band per non-paused host reveals that count. Published activity and liveness
are observable. Daily pseudonyms, mixing, smoothing and rounding do not guarantee
unlinkability: continuous observations, steady channel levels, timing and optional
filament presence can support correlation across days.

Explicitly enabled filaments publish a transformed CPU profile and may reveal
sustained CPU levels. They must remain disabled where those levels are private.
These documented disclosures are accepted; new disclosure beyond them, implicit
filament enablement or exposure of the recipe remains reportable.

## Known Limitations and Compensating Controls

nginx limits concurrent streams to eight per IPv4 address or IPv6 /64. The shipped
Caddy configurations have no per-client limit; only the bridge's global cap
applies. Multiple prefixes can exhaust nginx-protected capacity too. These are
known availability limitations, not blanket denial-of-service exclusions.

Loopback binding, private container networks, read-only filesystems, dropped
capabilities and the systemd sandbox reduce exposure only where configured.
They do not excuse a reachable application flaw. The bridge permits HTTP to the
hub; confidentiality on that hop depends on network protection or HTTPS.
Operator-controlled paths and addresses are not by themselves remote attacks,
but flaws that let an untrusted actor influence them remain in scope.

Relevant evidence includes `bridge/test/privacy.test.ts`, bridge configuration,
pipeline, server and static-file tests, frontend stream-validation tests, and
`deploy/test/`. Assess the actual implementation and deployment prerequisites;
this policy does not assert that those controls have passed a security audit.
