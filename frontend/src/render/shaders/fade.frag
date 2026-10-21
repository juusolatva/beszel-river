#version 300 es
precision highp float;
// Dims the previous frame for trails. The floor makes 8-bit buffers fade fully instead of leaving ghosts.

uniform sampler2D u_previous;
uniform float u_decay;
uniform float u_floor;

in vec2 v_uv;
out vec4 o_color;

void main() {
  o_color = max(texture(u_previous, v_uv) * u_decay - u_floor, 0.0);
}
