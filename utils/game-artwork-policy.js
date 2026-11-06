"use strict";
// Shared by the downloader and local reader, including existing large heroes.
module.exports = { MAX_BYTES: 40 * 1024 * 1024, HERO_MIN_WIDTH: 1200, HERO_MIN_HEIGHT: 450,
  isHero: size => !!size && size.width >= 1200 && size.height >= 450 && size.width / size.height >= 1.3 };
