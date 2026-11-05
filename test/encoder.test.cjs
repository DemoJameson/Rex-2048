const assert = require("node:assert/strict");
const test = require("node:test");
const {
  chooseEncoder,
  videoEncoderArgs,
} = require("../server/stream.cjs");

const available = (...names) => new Set(names);

test("encoder auto-detection prefers hardware and falls back to libx264", () => {
  assert.equal(
    chooseEncoder("auto", available("h264_videotoolbox", "libx264"), {
      platform: "darwin",
      exists: () => false,
      env: {},
    }),
    "h264_videotoolbox"
  );
  assert.equal(
    chooseEncoder("auto", available("h264_nvenc", "libx264"), {
      platform: "linux",
      exists: (path) => path === "/dev/nvidia0",
      env: {},
    }),
    "h264_nvenc"
  );
  assert.equal(
    chooseEncoder("auto", available("h264_vaapi", "libx264"), {
      platform: "linux",
      exists: (path) => path === "/dev/dri/renderD128",
      env: {},
    }),
    "h264_vaapi"
  );
  assert.equal(
    chooseEncoder("auto", available("libx264"), {
      platform: "linux",
      exists: () => false,
      env: {},
    }),
    "libx264"
  );
});

test("explicit unavailable encoder falls back to libx264", () => {
  assert.equal(
    chooseEncoder("h264_nvenc", available("libx264"), {
      platform: "linux",
      exists: () => false,
      env: {},
    }),
    "libx264"
  );
});

test("encoder arguments preserve 720p30 low-latency settings", () => {
  const settings = {
    gop: 30,
    bitrate: "2M",
    maxrate: "2500k",
    bufsize: "2500k",
    vaapiDevice: "/dev/dri/renderD128",
  };
  const x264 = videoEncoderArgs("libx264", settings);
  assert.ok(x264.includes("libx264"));
  assert.ok(x264.includes("ultrafast"));
  assert.ok(x264.includes("zerolatency"));
  assert.equal(x264[x264.indexOf("-g") + 1], "30");
  assert.equal(x264[x264.indexOf("-b:v") + 1], "2M");

  const nvenc = videoEncoderArgs("h264_nvenc", settings);
  assert.ok(nvenc.includes("h264_nvenc"));
  assert.ok(nvenc.includes("p4"));
  assert.ok(nvenc.includes("ll"));

  const vaapi = videoEncoderArgs("h264_vaapi", settings);
  assert.ok(vaapi.includes("h264_vaapi"));
  assert.ok(vaapi.includes("format=nv12,hwupload"));
  assert.ok(vaapi.includes("/dev/dri/renderD128"));
});
