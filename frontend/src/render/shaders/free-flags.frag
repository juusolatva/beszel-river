#version 300 es
precision highp int;
flat in uint v_free;
layout(location=0) out uint out_free;
void main() { out_free = v_free; }
