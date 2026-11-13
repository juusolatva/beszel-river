#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_source;
uniform int u_width;
uniform int u_capacity;
uniform int u_offset;
layout(location=0) out uint out_sum;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int i = p.y * u_width + p.x;
  out_sum = 0u;
  if (i >= u_capacity) return;
  out_sum = texelFetch(u_source, p, 0).r;
  int j = i - u_offset;
  if (j >= 0) out_sum += texelFetch(u_source, ivec2(j % u_width, j / u_width), 0).r;
}
