#version 300 es
precision highp float;

in vec2 v_local;
in float v_length;
in vec3 v_rgb;

out vec4 o_color;

void main() {
  // Distance to the tail-head segment, in half-widths: soft capsule, brightest at the head.
  float along = clamp(v_local.x, 0.0, v_length);
  float dist = length(vec2(v_local.x - along, v_local.y));
  float edge = clamp(1.0 - dist, 0.0, 1.0);
  float toward = v_length > 0.0 ? along / v_length : 1.0;
  o_color = vec4(v_rgb * edge * edge * mix(0.2, 1.0, toward), 1.0);
}
