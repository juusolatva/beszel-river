#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
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

void main() {
  v_motion = a_motion;
  v_lifetime = a_lifetime;
  v_spawn = a_spawn;
  v_identity = a_identity;
  gl_Position = vec4(0.0);
  if (a_identity.z == 0u) return;
  v_lifetime.x = a_lifetime.x + u_dt;
  // Death precedes motion and uses the newly stored Float32 age, as on the CPU.
  if (v_lifetime.x > a_lifetime.y || a_motion.y >= u_bounds.y || a_motion.x <= u_bounds.x || a_motion.x > u_bounds.z || (u_bounds.w > 0.0 && a_motion.x == u_bounds.z)) {
    v_identity.z = 0u;
    return;
  }
  int slot = int(a_identity.x);
  vec4 band = texelFetch(u_stream, ivec2(0, slot), 0);
  vec4 shape = texelFetch(u_stream, ivec2(1, slot), 0);
  vec2 flow = flowAt(a_motion.xy);
  float up = band.z * a_spawn.x;
  float limit = u_physics.y * up;
  float side = clamp(flow.x * band.w * up + (centerAt(a_motion.y, slot, band, shape) + a_spawn.y * band.y - a_motion.x) * u_physics.x, -limit, limit);
  v_motion.z = a_motion.z + (side - a_motion.z) * u_physics.z;
  v_motion.w = a_motion.w + (up * (1.0 + 0.3 * flow.y * band.w) - a_motion.w) * u_physics.z;
  v_motion.xy = a_motion.xy + v_motion.zw * u_dt;
}
