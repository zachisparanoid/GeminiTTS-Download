const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeTitle, extensionFor, composeFilename } = require("../filename.js");

describe("sanitizeTitle", () => {
  test("preserves clean ASCII", () => {
    assert.equal(sanitizeTitle("My Chat Title"), "My-Chat-Title");
  });

  test("strips filesystem-unsafe characters", () => {
    assert.equal(sanitizeTitle('My/File:Name?<>"|\\*'), "MyFileName");
  });

  test("strips control characters", () => {
    assert.equal(sanitizeTitle("hello\x00world\x1F\x7F"), "helloworld");
  });

  test("collapses runs of whitespace into a single dash", () => {
    assert.equal(sanitizeTitle("Hello   World\t\nHere"), "Hello-World-Here");
  });

  test("collapses runs of dashes", () => {
    assert.equal(sanitizeTitle("a---b----c"), "a-b-c");
  });

  test("trims edge dashes", () => {
    assert.equal(sanitizeTitle("---hello---"), "hello");
  });

  test("preserves Unicode characters (modern filesystems handle them)", () => {
    const out = sanitizeTitle("Émojis 🎉 here");
    assert.equal(out, "Émojis-🎉-here");
  });

  test("caps at 80 characters and re-trims edge dashes", () => {
    const long = "a".repeat(75) + " word with overflow";
    const out = sanitizeTitle(long);
    assert.ok(out.length <= 80);
    assert.ok(!out.endsWith("-"));
  });

  test("falls back to gemini-tts on empty input", () => {
    assert.equal(sanitizeTitle(""), "gemini-tts");
    assert.equal(sanitizeTitle("   "), "gemini-tts");
    assert.equal(sanitizeTitle("///***"), "gemini-tts");
    assert.equal(sanitizeTitle(null), "gemini-tts");
    assert.equal(sanitizeTitle(undefined), "gemini-tts");
  });
});

describe("extensionFor", () => {
  test("known MIME types map to expected extensions", () => {
    assert.equal(extensionFor("audio/mpeg"), ".mp3");
    assert.equal(extensionFor("audio/mp3"), ".mp3");
    assert.equal(extensionFor("audio/ogg"), ".ogg");
    assert.equal(extensionFor("audio/wav"), ".wav");
    assert.equal(extensionFor("audio/wave"), ".wav");
    assert.equal(extensionFor("audio/x-wav"), ".wav");
    assert.equal(extensionFor("audio/webm"), ".webm");
    assert.equal(extensionFor("audio/aac"), ".aac");
    assert.equal(extensionFor("audio/mp4"), ".m4a");
  });

  test("strips codec parameters before lookup", () => {
    assert.equal(extensionFor('audio/mpeg; codecs="mp3"'), ".mp3");
    assert.equal(extensionFor("audio/ogg;codecs=opus"), ".ogg");
  });

  test("is case-insensitive", () => {
    assert.equal(extensionFor("AUDIO/MPEG"), ".mp3");
    assert.equal(extensionFor("Audio/Ogg"), ".ogg");
  });

  test("unknown MIME types fall back to .bin", () => {
    assert.equal(extensionFor("application/octet-stream"), ".bin");
    assert.equal(extensionFor("audio/weird-codec"), ".bin");
    assert.equal(extensionFor(""), ".bin");
    assert.equal(extensionFor(null), ".bin");
    assert.equal(extensionFor(undefined), ".bin");
  });
});

describe("composeFilename", () => {
  test("composes title-index-extension", () => {
    const out = composeFilename({
      title: "My Chat",
      messageIndex: 3,
      mimeType: "audio/mpeg",
    });
    assert.equal(out, "My-Chat-3.mp3");
  });

  test("uses 1 as default index when invalid", () => {
    assert.equal(
      composeFilename({ title: "X", messageIndex: 0, mimeType: "audio/mpeg" }),
      "X-1.mp3"
    );
    assert.equal(
      composeFilename({ title: "X", messageIndex: -5, mimeType: "audio/mpeg" }),
      "X-1.mp3"
    );
    assert.equal(
      composeFilename({ title: "X", messageIndex: NaN, mimeType: "audio/mpeg" }),
      "X-1.mp3"
    );
    assert.equal(
      composeFilename({ title: "X", mimeType: "audio/mpeg" }),
      "X-1.mp3"
    );
  });

  test("floors fractional indices", () => {
    assert.equal(
      composeFilename({ title: "X", messageIndex: 3.7, mimeType: "audio/mpeg" }),
      "X-3.mp3"
    );
  });

  test("falls back to gemini-tts when title sanitizes to empty", () => {
    assert.equal(
      composeFilename({ title: "///", messageIndex: 2, mimeType: "audio/ogg" }),
      "gemini-tts-2.ogg"
    );
  });

  test("uses .bin for unknown MIME types", () => {
    assert.equal(
      composeFilename({ title: "Chat", messageIndex: 1, mimeType: "weird/type" }),
      "Chat-1.bin"
    );
  });
});
