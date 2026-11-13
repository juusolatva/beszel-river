#version 300 es
precision highp float;
precision highp int;
layout(location=3) in uvec4 a_identity;
uniform int u_width;
uniform int u_height;
flat out uint v_free;
void main() {
  ivec2 p = ivec2(gl_VertexID % u_width, gl_VertexID / u_width);
  gl_Position = vec4((vec2(p) + 0.5) / vec2(u_width, u_height) * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  v_free = a_identity.z == 0u ? 1u : 0u;
}
