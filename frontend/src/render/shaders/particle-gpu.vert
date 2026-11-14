#version 300 es
// particle.vert for the experimental GPU simulation: the same capsule, with the CPU's per-instance
// fields (ParticleSystem.step) derived here from simulation state and the stream texture.
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;

layout(location = 0) in vec2 a_corner; // x: 0 tail .. 1 head, y: -1 .. 1 across
layout(location = 1) in vec4 a_motion; // x, y, vx, vy
layout(location = 2) in vec4 a_lifetime; // age, life, hueJitter, size
layout(location = 3) in vec4 a_spawn; // speedJitter, laneOffset: bound for the shared layout, unused
layout(location = 4) in uvec4 a_identity; // streamSlot, generation, active, spawnCounter

uniform sampler2D u_stream;
uniform usampler2D u_command;
uniform float u_aspect;
uniform float u_pixel; // world units per device px
uniform float u_depositScale; // trail deposit relative to a 60 Hz frame
uniform float u_hue; // global hue, turns
uniform float u_intensity; // LOOK.intensity times the budget's intensity scale
uniform float u_sizeScale; // LOOK.sizePx times the device pixel ratio
uniform vec4 u_look; // lightness, hueGradient, fadeIn, fadeOut

out vec2 v_local; // along and across, in half-widths
out float v_length; // segment length, in half-widths
out vec3 v_rgb;

vec3 oklchToLinearSrgb(float L, float C, float hue) {
  float h = hue * 6.28318530718;
  float a = C * cos(h);
  float b = C * sin(h);
  float l = L + 0.3963377774 * a + 0.2158037573 * b;
  float m = L - 0.1055613458 * a - 0.0638541728 * b;
  float s = L - 0.0894841775 * a - 1.2914855480 * b;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

void main() {
  v_local = vec2(0.0);
  v_length = 0.0;
  v_rgb = vec3(0.0);
  // Inactive slots, and defensively any stale generation, collapse outside the clip volume.
  if (a_identity.z == 0u || a_identity.x >= 32u ||
      texelFetch(u_command, ivec2(0, int(a_identity.x)), 0).x != a_identity.y) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  int slot = int(a_identity.x);
  float hueOffset = texelFetch(u_stream, ivec2(1, slot), 0).z;
  vec4 look = texelFetch(u_stream, ivec2(2, slot), 0); // brightness, chroma, streakSeconds, presence

  vec2 head = a_motion.xy;
  vec2 tail = head - a_motion.zw * look.z;
  float age = a_lifetime.x;
  // Live stepped particles have 0 <= age <= life; the clamp keeps corrupt state from subtracting light.
  float fade = clamp(min(age / u_look.z, (a_lifetime.y - age) / u_look.w), 0.0, 1.0);
  float hue = fract(u_hue + head.y * u_look.y + hueOffset + a_lifetime.z);
  float intensity = u_intensity * fade * look.x;

  float hw = a_lifetime.w * u_sizeScale * u_pixel;
  vec2 d = head - tail;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(0.0, 1.0);
  vec2 normal = vec2(-dir.y, dir.x);

  // Extend by one half-width past both ends so the capsule caps fit.
  float along = mix(-hw, len + hw, a_corner.x);
  vec2 pos = tail + dir * along + normal * a_corner.y * hw;

  v_local = vec2(along / hw, a_corner.y);
  v_length = len / hw;
  v_rgb = max(oklchToLinearSrgb(u_look.x, look.y, hue), 0.0) * intensity * u_depositScale;
  gl_Position = vec4(pos.x / u_aspect * 2.0 - 1.0, pos.y * 2.0 - 1.0, 0.0, 1.0);
}
