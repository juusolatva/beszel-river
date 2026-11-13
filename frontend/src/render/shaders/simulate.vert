#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
layout(location=0) in vec4 a_motion;
layout(location=1) in vec4 a_lifetime;
layout(location=2) in vec4 a_spawn;
layout(location=3) in uvec4 a_identity;
out vec4 v_motion;
out vec4 v_lifetime;
out vec4 v_spawn;
flat out uvec4 v_identity;
uniform sampler2D u_flow;
uniform sampler2D u_stream;
uniform usampler2D u_command;
uniform usampler2D u_prefix;
uniform int u_width;
uniform int u_capacity;
uniform uint u_limit;
uniform uint u_seed;
uniform bool u_enabled;
uniform vec4 u_birth;
uniform vec4 u_lifeSize;
uniform vec4 u_filament;
uniform float u_span;
uniform float u_dt;
uniform vec4 u_bounds;
uniform float u_cell;
// CPU-derived constants: steering, max slope, inertia blend.
uniform vec3 u_physics;
uniform vec2 u_braid;

float centerAt(float y, int slot, vec4 band, vec4 shape) {
  if (y < -0.02 || y > 1.08) {
    return band.x + band.y * u_braid.x * sin(6.283185307179586 * (y * u_braid.y + shape.x) + shape.y);
  }
  float pos = (y + 0.02) * (63.0 / 1.1);
  int i = min(int(floor(pos)), 62);
  vec4 a = texelFetch(u_stream, ivec2(8 + i / 4, slot), 0);
  int j = i + 1;
  vec4 b = texelFetch(u_stream, ivec2(8 + j / 4, slot), 0);
  return a[i % 4] + (b[j % 4] - a[i % 4]) * (pos - float(i));
}

vec2 flowAt(vec2 p) {
  ivec2 size = textureSize(u_flow, 0);
  vec2 f = clamp(p / u_cell, vec2(0.0), vec2(size) - 1.001);
  ivec2 c = ivec2(floor(f));
  vec2 t = f - vec2(c);
  return texelFetch(u_flow, c, 0).rg * ((1.0 - t.x) * (1.0 - t.y))
    + texelFetch(u_flow, c + ivec2(1, 0), 0).rg * (t.x * (1.0 - t.y))
    + texelFetch(u_flow, c + ivec2(0, 1), 0).rg * ((1.0 - t.x) * t.y)
    + texelFetch(u_flow, c + ivec2(1, 1), 0).rg * (t.x * t.y);
}

uint rng;
float randomUnit() {
  rng = rng * 747796405u + 2891336453u;
  uint word = ((rng >> ((rng >> 28u) + 4u)) ^ rng) * 277803737u;
  return float(((word >> 22u) ^ word) >> 8u) / 16777216.0;
}
float gaussian() {
  float u = 1.0 - randomUnit();
  float v = randomUnit();
  return sqrt(-2.0 * log(u)) * cos(6.283185307179586 * v);
}
uint prefixAt(int i) { return texelFetch(u_prefix, ivec2(i % u_width, i / u_width), 0).r; }
float streamValue(int slot, int component) {
  return texelFetch(u_stream, ivec2(component / 4, slot), 0)[component % 4];
}
void birth() {
  uint freeTotal = prefixAt(u_capacity - 1);
  uint live = uint(u_capacity) - freeTotal;
  uint room = u_limit > live ? u_limit - live : 0u;
  uint requests = texelFetch(u_command, ivec2(0, 31), 0).w;
  uint births = min(requests, min(room, freeTotal));
  uint rank = prefixAt(gl_VertexID) - 1u;
  if (rank >= births) return;
  for (int slot = 0; slot < 32; slot++) {
    uvec4 cmd = texelFetch(u_command, ivec2(0, slot), 0);
    if (cmd.y == 0u || rank < cmd.z || rank >= cmd.w) continue;
    // Sticky invalid marker: untimed validation rejects this run rather than aliasing a birth.
    if (v_identity.w == 0xffffffffu) { v_spawn.z = 1.0; return; }
    v_identity = uvec4(uint(slot), cmd.x, 1u, v_identity.w + 1u);
    rng = u_seed ^ uint(gl_VertexID) * 0x9e3779b9u ^ cmd.x * 0x85ebca6bu ^ v_identity.w * 0xc2b2ae35u;
    vec4 band = texelFetch(u_stream, ivec2(0, slot), 0);
    vec4 shape = texelFetch(u_stream, ivec2(1, slot), 0);
    v_spawn = vec4(mix(u_birth.x, u_birth.y, randomUnit()), 0.0, 0.0, 0.0);
    float x;
    if (shape.w > 0.001 && randomUnit() < shape.w) {
      float target = randomUnit() * streamValue(slot, 23);
      int lane = 5;
      for (int j = 0; j < 5; j++) { if (target < streamValue(slot, 18 + j)) { lane = j; break; } }
      float activity = streamValue(slot, 12 + lane);
      v_spawn.y = ((float(lane) + 0.5) / 6.0 * 2.0 - 1.0) * u_span + gaussian() * mix(u_filament.x, u_filament.y, activity);
      x = centerAt(0.0, slot, band, shape) + v_spawn.y * band.y;
      v_spawn.x *= mix(u_filament.z, u_filament.w, activity);
    } else {
      x = centerAt(0.0, slot, band, shape) + gaussian() * band.y * u_birth.z;
    }
    v_motion = vec4(x, -0.02 * randomUnit(), 0.0, band.z);
    v_lifetime = vec4(0.0, mix(u_lifeSize.x, u_lifeSize.y, randomUnit()), (randomUnit() - 0.5) * 2.0 * u_birth.w, mix(u_lifeSize.z, u_lifeSize.w, randomUnit()));
    return;
  }
}

void main() {
  v_motion = a_motion;
  v_lifetime = a_lifetime;
  v_spawn = a_spawn;
  v_identity = a_identity;
  gl_Position = vec4(0.0);
  if (v_spawn.z != 0.0) return;
  if (u_enabled && a_identity.z == 0u) birth();
  if (v_identity.z == 0u) return;
  v_lifetime.x = v_lifetime.x + u_dt;
  // Death precedes motion and uses the newly stored Float32 age, as on the CPU.
  if (v_lifetime.x > v_lifetime.y || v_motion.y >= u_bounds.y || v_motion.x <= u_bounds.x || v_motion.x > u_bounds.z || (u_bounds.w > 0.0 && v_motion.x == u_bounds.z)) {
    v_identity.z = 0u;
    return;
  }
  int slot = int(v_identity.x);
  vec4 band = texelFetch(u_stream, ivec2(0, slot), 0);
  vec4 shape = texelFetch(u_stream, ivec2(1, slot), 0);
  vec2 flow = flowAt(v_motion.xy);
  float up = band.z * v_spawn.x;
  float limit = u_physics.y * up;
  float side = clamp(flow.x * band.w * up + (centerAt(v_motion.y, slot, band, shape) + v_spawn.y * band.y - v_motion.x) * u_physics.x, -limit, limit);
  v_motion.z = v_motion.z + (side - v_motion.z) * u_physics.z;
  v_motion.w = v_motion.w + (up * (1.0 + 0.3 * flow.y * band.w) - v_motion.w) * u_physics.z;
  v_motion.xy = v_motion.xy + v_motion.zw * u_dt;
}
