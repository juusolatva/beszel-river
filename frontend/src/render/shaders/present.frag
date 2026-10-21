#version 300 es
precision highp float;
// Tone-maps the additive linear buffer and encodes it as sRGB for the screen.

uniform sampler2D u_image;
uniform float u_exposure;

in vec2 v_uv;
out vec4 o_color;

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 c = 1.0 - exp(-texture(u_image, v_uv).rgb * u_exposure);
  o_color = vec4(linearToSrgb(c), 1.0);
}
