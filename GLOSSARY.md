# River

The river is an abstract animation shaped by activity on monitored hosts. Its language separates host measurements, abstract visual controls and the resulting motion.

## Language

### Hosts and activity

**Host**:
A machine monitored by the Beszel hub whose activity can contribute a stream to the river.
_Avoid_: Server or system when referring to the monitored machine.

**Paused host**:
A host whose monitoring is suspended in the hub and which is omitted from the river.
_Avoid_: Unavailable host, removed host.

**Sample**:
A set of measurements of one host's activity at a particular time or over a reporting interval.
_Avoid_: Frame, channel.

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
The private mapping from activity features to visual channels, including how their changes are spread over time.
_Avoid_: Look settings, metric-to-colour map.

### Abstract river state

**Stream**:
The abstract representation of one non-paused host's contribution to the river, including its visual channels and reporting state. A stream remains present when its host becomes unavailable.
_Avoid_: Connection, band when referring to the abstract state.

**Stream ID**:
A temporary identity for a stream within one UTC day, without naming its host.
_Avoid_: Host ID, permanent identity.

**Frame**:
A complete, ordered description of the river's streams at a particular time.
_Avoid_: Sample, rendered frame when referring to river state.

**Alive**:
The stream state indicating that its host is reporting and the hub connection is considered live.
_Avoid_: Present, visible, reachable when describing this state.

**Not alive**:
The stream state indicating that its host is not reporting or the hub connection is no longer considered live. The stream remains in the river.
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
The optional transformed per-core activity profile that gives a stream finer strands. Its values describe relative lane activity rather than the identities or number of CPU cores.
_Avoid_: Core readings, one strand per core.

### Visible river

**River**:
The combined upward flow of rainbow-coloured particles and their trails across all bands.

**Look tunables**:
The client-side visual constants controlling particle motion, trail fading and colour palettes, independent of live data.
_Avoid_: Mixing recipe.

**Offline river**:
The river's state when the viewer's live-data connection is no longer considered available. Streams thin out and lose colour while their reporting states remain unchanged.
_Avoid_: All hosts down.

**Band**:
The soft-edged region occupied by a stream in the river, overlapping and braiding with neighbouring bands.
_Avoid_: Host, stream when referring specifically to the visible region.

**Lane**:
One of the positions across a band around which particles gather according to its filament activity.
_Avoid_: CPU core.

**Draining stream**:
A stream fading out after its identity is absent from the latest frame, while its remaining particles finish their motion. Daily identity changes can cause draining even when the host keeps reporting.
_Avoid_: Unavailable host, not-alive stream.
