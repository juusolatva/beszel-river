# River

The river is an abstract animation shaped by activity on monitored hosts. Its language separates host measurements, abstract visual controls and the resulting motion.

## Language

### Hosts and activity

**Host**:
A machine monitored by the Beszel hub whose activity can contribute a stream to the river.
_Avoid_: Server or system when referring to the monitored machine, except when naming Beszel's own records and IDs.

**Paused host**:
A host whose monitoring is suspended in the hub and which is omitted from the river.
_Avoid_: Unavailable host, removed host.

**Sample**:
A set of measurements of one host's activity at a particular time or over a reporting interval.
_Avoid_: Frame, channel.

**Minute record**:
A sample averaged over one minute, which the hub stores for each host. Live minute records are spread over the following minute; those replayed at startup apply at once.
_Avoid_: Realtime sample, frame.

**Realtime sample**:
A sample taken once a second, which arrives only while viewers are watching and the realtime source is in use.
_Avoid_: Minute record, frame.

**Baseline**:
A host's recent network and disk activity history, used as the reference for its usual traffic levels.
_Avoid_: Static threshold, quota, fixed limit.

**Feature**:
A normalized aspect of host activity, such as load, traffic change or burstiness, used as an input to mixing.
_Avoid_: Channel.

**Per-core profile**:
A summary of the spread of CPU activity from a host's idlest cores to its busiest cores, independent of their identities.
_Avoid_: Core map.

**Mixing recipe**:
The private weights and smoothing that turn features into every channel except width, together with the optional filament mapping and how minute records are spread over the following minute.
_Avoid_: Look settings, metric-to-colour map.

**Glide**:
The gradual move of a stream's channels and filaments towards a live minute record's values over the following minute, instead of one step.
_Avoid_: Smoothing, easing.

**Scattered pulse**:
One of the pulses spread over the minute after a live minute record: the record's own pulse shortly after it arrives, then possibly weaker ones at random times.
_Avoid_: Heartbeat, extra sample.

### Abstract river state

**Stream**:
The abstract representation of one non-paused host's contribution to the river, including its visual channels and reporting state. A stream remains present when its host becomes unavailable.
_Avoid_: Connection, band when referring to the abstract state.

**Stream ID**:
A temporary identity for a stream within one UTC day, without naming its host.
_Avoid_: Host ID, permanent identity.

**Frame**:
A complete, ordered description of the river's streams at a particular time.
_Avoid_: Sample, animation frame when referring to river state.

**Reporting state**:
Whether a stream is alive or not alive.
_Avoid_: Paused, present, visible.

**Alive**:
The reporting state indicating that the hub reports the stream's host as up and the bridge's hub connection is considered live.
_Avoid_: Present, visible, reachable when describing this state.

**Not alive**:
The reporting state indicating that the hub does not report the stream's host as up, or the bridge's hub connection is no longer considered live. The stream remains in the river.
_Avoid_: Paused host, removed stream.

**Channel**:
One of the abstract numeric controls for a stream's appearance: width, flow, density, turbulence, pulse or heat.
_Avoid_: Metric, feature.

**Width**:
A stream's relative band breadth, unrelated to its host's capacity or core count.
_Avoid_: Capacity, core count, bandwidth.

**Flow**:
The channel for upward particle speed.
_Avoid_: Traffic rate, data throughput.

**Density**:
The channel for particle spawning rate within a stream.
_Avoid_: Particle count.

**Turbulence**:
The channel for sideways variation in particle motion.
_Avoid_: Packet loss, error rate, noise level.

**Pulse**:
The channel for the strength of a brief surge in a stream's particle spawning and brightness, shaped by host activity.
_Avoid_: Heartbeat, sample arrival.

**Heat**:
The channel for hue drift, with a neutral midpoint.
_Avoid_: Temperature.

**Filaments**:
The optional six values per stream, made from the sorted per-core usage, transformed by the mixing recipe and reordered daily, that give a stream finer strands. They hide which cores are which and how many there are, but not sustained CPU levels.
_Avoid_: Core readings, one strand per core, relative activity.

### Visible river

**River**:
The combined upward flow of rainbow-coloured particles and their trails across all bands.

**Animation frame**:
One drawing of the river on screen, many times a second, independent of when frames arrive.
_Avoid_: Frame when referring to drawing.

**Look tunables**:
The client-side visual constants controlling particle motion, braiding, lifetimes, trails, hue and how quickly channels are eased, independent of live data.
_Avoid_: Mixing recipe, colour palette.

**Viewer**:
A browser connected to the live stream of frames. While there are viewers, the realtime source asks for realtime samples.
_Avoid_: User, client when referring to someone watching the river.

**Offline river**:
The river's state when the viewer's live-data connection is no longer considered available. Streams thin out and lose colour while their reporting states remain unchanged.
_Avoid_: All hosts down.

**Band**:
The soft-edged region occupied by a stream in the river, overlapping and braiding with neighbouring bands.
_Avoid_: Host, stream when referring specifically to the visible region.

**Lane**:
One of six positions across a band around which particles gather according to that lane's filament value.
_Avoid_: CPU core.

**Draining stream**:
A stream fading out after its identity is absent from the latest frame, while its remaining particles finish their motion. Daily identity changes can cause draining even when the host keeps reporting.
_Avoid_: Unavailable host, not-alive stream.
