#version 300 es
// One instanced quad per particle, stretched from tail to head (a capsule), coloured from OKLCH.

layout(location = 0) in vec2 a_corner; // x: 0 tail .. 1 head, y: -1 .. 1 across
layout(location = 1) in vec4 a_segment; // tail.xy, head.xy in world units
layout(location = 2) in vec2 a_shade; // hue (turns), intensity; 0 intensity marks a dead slot
layout(location = 3) in vec2 a_meta; // stream slot index, size jitter

const int MAX_STREAMS = 32;

uniform float u_aspect;
uniform float u_pixel; // world units per device px
uniform float u_depositScale; // trail deposit relative to a 60 Hz frame
uniform float u_sizeScale; // device px per unit of size jitter
uniform float u_lightness;
uniform float u_chroma[MAX_STREAMS]; // per stream slot, eased every frame

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
  // Dead slots, and live ones that add no light, collapse outside the clip volume before any colour work.
  if (a_shade.y <= 0.0) {
    v_local = vec2(0.0);
    v_length = 0.0;
    v_rgb = vec3(0.0);
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec2 tail = a_segment.xy;
  vec2 head = a_segment.zw;
  float hw = a_meta.y * u_sizeScale * u_pixel;
  vec2 d = head - tail;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(0.0, 1.0);
  vec2 normal = vec2(-dir.y, dir.x);

  // Extend by one half-width past both ends so the capsule caps fit.
  float along = mix(-hw, len + hw, a_corner.x);
  vec2 pos = tail + dir * along + normal * a_corner.y * hw;

  v_local = vec2(along / hw, a_corner.y);
  v_length = len / hw;
  float chroma = u_chroma[clamp(int(a_meta.x + 0.5), 0, MAX_STREAMS - 1)];
  v_rgb = max(oklchToLinearSrgb(u_lightness, chroma, a_shade.x), 0.0) * a_shade.y * u_depositScale;
  gl_Position = vec4(pos.x / u_aspect * 2.0 - 1.0, pos.y * 2.0 - 1.0, 0.0, 1.0);
}
