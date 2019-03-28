//
// Check for valid SSML
//

const convert = require('xml-js');
const ffprobe = require('ffprobe');
const ffprobeStatic = require('ffprobe-static');

function createTagError(element, attribute, undefinedValue) {
  const error = {type: 'tag', tag: element.name};

  error.type = 'tag';
  error.tag = element.name;
  error.attribute = attribute;
  error.value = (undefinedValue) ? undefined : element.attributes[attribute];
  return error;
}

function prosodyRate(text) {
  const rates = ['x-slow', 'slow', 'medium', 'fast', 'x-fast'];
  const values = [0.3, 0.6, 1, 1.5, 2];

  let i = rates.indexOf(text);
  if (i > -1) {
    return values[i];
  }

  // It must be of the form #%
  let rate;
  if (text.match('[0-9]+%')) {
    rate = parseInt(text);
    if (rate < 20) {
      rate = undefined;
    }
  }

  return (rate) ? (rate / 100.0) : undefined;
}

function readDuration(text, maximum) {
  // It must be of the form #s or #ms
  let time;
  if (!maximum && (text === 'infinity')) {
    time = Number.MAX_SAFE_INTEGER;
  } else if (text.match('[0-9]+ms')) {
    time = parseInt(text);
  } else if (text.match(/^[0-9]+(\.[0-9]+)?s$/g)) {
    time = 1000 * parseInt(text);
  } else {
    // No good
    return undefined;
  }

  if (maximum) {
    time = (time <= maximum) ? time : undefined;
  }

  return time;
}

function getAudioFiles(element) {
  let files = [];

  if (element.elements) {
    element.elements.forEach((item) => {
      files = files.concat(getAudioFiles(item));
    });
  } else if ((element.name === 'audio') && (element.attributes.src)) {
    files.push(element.attributes.src);
  }

  return files;
}

function validateAudio(src) {
  const errors = [];

  // It can be one of the built-in Amazon sounds (from the soundbank)

  // Must be MP3 at HTTPS endpoint
  if (!src.match(/^https(.)+\.mp3/gi)) {
    errors.push({type: 'audio', value: src, detail: 'Not MP3 on HTTPS'});
    return Promise.resolve(errors);
  }

  // Make sure we can access the audio file
  // The sample rate must be 22050Hz, 24000Hz, or 16000Hz
  // and the bit rate must be 48kbps
  // audio file length cannot be more than 240 seconds
  return ffprobe(src, {path: ffprobeStatic.path})
  .then((info) => {
    info.streams.forEach((stream) => {
      if ([22050, 24000, 16000].indexOf(parseInt(stream.sample_rate)) === -1) {
        errors.push({type: 'audio', value: src, detail: `Invalid bit rate ${stream.sample_rate} Hz`})
      }
      if (stream.bit_rate != 48000) {
        errors.push({type: 'audio', value: src, detail: `Invalid bit rate ${stream.bit_rate}`})
      }
      if (stream.duration > 240) {
        errors.push({type: 'audio', value: src, detail: `Invalid duration ${stream.duration} Hz`})
      }
    });

    return errors;
  }).catch((err) => {
    // We can't read this audio file
    errors.push({type: 'audio', value: src, detail: 'Can\'t access file'});
    return errors;
  });
}

function checkForValidTags(errors, element, platform) {
  const validTags = ['audio', 'break', 'emphasis', 'p', 'prosody', 's', 'say-as', 'speak', 'sub'];
  const validAmazonTags = ['amazon:effect', 'lang', 'phoneme', 'voice', 'w'];
  const validGoogleTags = ['par', 'seq', 'media'];

  if (element.name) {
    if ((validTags.indexOf(element.name) === -1) &&
      !(((platform === 'amazon') && (validAmazonTags.indexOf(element.name) !== -1)) ||
      ((platform === 'google') && (validGoogleTags.indexOf(element.name) !== -1)))) {
      errors.push({type: 'tag', tag: element.name});
    } else {
      // Let's check values based on the tag
      const attributes = Object.keys(element.attributes || {});

      switch (element.name) {
        case 'amazon:effect':
          // Must be name attribute with whispered value
          attributes.forEach((attribute) => {
            if (attribute === 'name') {
              if (['whispered'].indexOf(element.attributes.name) === -1) {
                errors.push(createTagError(element, attribute));
              }
            } else {
              // Invalid attribute
              errors.push(createTagError(element, attribute, true));
            }
          });

          // Also, name is required
          if (attributes.length === 0) {
            errors.push(createTagError(element, 'none'));
          }
          break;
        case 'audio':
          // Must be src attribute
          attributes.forEach((attribute) => {
            if ((platform === 'google') && (attribute === 'clipBegin')) {
              if (readDuration(element.attributes.clipBegin) === undefined) {
                errors.push(createTagError(element, attribute));
              }
            } else if ((platform === 'google') && (attribute === 'clipEnd')) {
              if (readDuration(element.attributes.clipEnd) === undefined) {
                errors.push(createTagError(element, attribute));
              }
            } else if ((platform === 'google') && (attribute === 'speed')) {
              if (!element.attributes.speed.match(/^(\+)?[0-9]+(\.[0-9]+)?$/g)) {
                errors.push(createTagError(element, attribute));
              }
            } else if ((platform === 'google') && (attribute === 'repeatCount')) {
              if (!element.attributes.repeatCount.match(/^(\+)?[0-9]+(\.[0-9]+)?$/g)) {
                errors.push(createTagError(element, attribute));
              }
            } else if ((platform === 'google') && (attribute === 'repeatDur')) {
              if (readDuration(element.attributes.repeatDur) === undefined) {
                errors.push(createTagError(element, attribute));
              }
            } else if ((platform === 'google') && (attribute === 'soundLevel')) {
              // It's OK if it's of the form +xdB or - xdB; value doesn't matter
              if (!element.attributes.soundLevel.match(/^[+-][0-9]+(\.[0-9]+)?dB$/g)) {
                errors.push(createTagError(element, attribute));
              }
            } else if (attribute !== 'src') {
              // Invalid attribute
              errors.push(createTagError(element, attribute, true));
            }
          });

          // Also, src is required
          if (attributes.length === 0) {
            errors.push(createTagError(element, 'none'));
          }
          break;
        case 'break':
          // Attribute must be time or strength
          attributes.forEach((attribute) => {
            if (attribute === 'strength') {
              if (['none', 'x-weak', 'weak', 'medium', 'strong', 'x-strong']
                .indexOf(element.attributes.strength) === -1) {
                errors.push(createTagError(element, attribute));
              }
            } else if (attribute === 'time') {
              // Must be valid duration
              if (readDuration(element.attributes.time, 10000) === undefined) {
                errors.push(createTagError(element, attribute));
              }
            } else {
              // Invalid attribute
              errors.push(createTagError(element, attribute, true));
            }
          });
          break;
        case 'emphasis':
          // Must be level attribute
          attributes.forEach((attribute) => {
            if (attribute === 'level') {
              if (['strong', 'moderate', 'reduced']
                .indexOf(element.attributes.level) === -1) {
                // None is also allowed on Google
                if ((platform !== 'google') || (element.attributes.level !== 'none')) {
                  errors.push(createTagError(element, attribute));
                }
              }
            } else {
              // Invalid attribute
              errors.push(createTagError(element, attribute, true));
            }
          });

          // Also, level is required
          if (attributes.length === 0) {
            errors.push(createTagError(element, 'none'));
          }
          break;
        case 'lang':
          // Must be xml:lang attribute
          attributes.forEach((attribute) => {
            if (attribute === 'xml:lang') {
              if (['en-US', 'en-GB', 'en-IN', 'en-AU', 'en-CA', 'de-DE', 'es-ES', 'it-IT', 'ja-JP', 'fr-FR']
                .indexOf(element.attributes['xml:lang']) === -1) {
                errors.push(createTagError(element, attribute));
              }
            } else {
              // Invalid attribute
              errors.push(createTagError(element, attribute, true));
            }
          });

          // Also, xml:lang is required
          if (attributes.length === 0) {
            errors.push(createTagError(element, 'none'));
          }
          break;
        case 'media':
          attributes.forEach((attribute) => {
            if (attribute === 'xml:id') {
              if (!element.attributes['xml:id'].match(/^([-_#]|\p{L}|\p{D})+$/g)) {
                errors.push(createTagError(element, attribute));
              }
            } else if (attribute === 'begin') {
              if (!element.attributes.begin.match(/^[+-]?[0-9]+(\.[0-9]+)?(h|min|s|ms)$/g)
                && !element.attributes.begin.match(/^.\.(begin|end)[+-][0-9]+(\.[0-9]+)?(h|min|s|ms)$/g)) {
                errors.push(createTagError(element, attribute));
              }
            } else if (attribute === 'end') {
              if (!element.attributes.end.match(/^[+-]?[0-9]+(\.[0-9]+)?(h|min|s|ms)$/g)
                && !element.attributes.end.match(/^.\.(begin|end)[+-][0-9]+(\.[0-9]+)?(h|min|s|ms)$/g)) {
                errors.push(createTagError(element, attribute));
              }
            } else if (attribute === 'repeatCount') {
              if (!element.attributes.repeatCount.match(/^(\+)?[0-9]+(\.[0-9]+)?$/g)) {
                errors.push(createTagError(element, attribute));
              }
            } else if (attribute === 'repeatDur') {
              if (readDuration(element.attributes.repeatDur) === undefined) {
                errors.push(createTagError(element, attribute));
              }
            } else if (attribute === 'soundLevel') {
              // It's OK if it's of the form +xdB or - xdB; value doesn't matter
              if (!element.attributes.soundLevel.match(/^[+-][0-9]+(\.[0-9]+)?dB$/g)) {
                errors.push(createTagError(element, attribute));
              }
            } else if (attribute === 'fadeInDur') {
              if (readDuration(element.attributes.fadeInDur) === undefined) {
                errors.push(createTagError(element, attribute));
              }
            } else if (attribute === 'fadeOutDur') {
              if (readDuration(element.attributes.fadeOutDur) === undefined) {
                errors.push(createTagError(element, attribute));
              }
            } else {
              // Invalid attribute
              errors.push(createTagError(element, attribute, true));
            }
          });

          break;
        case 'p':
          // No attributes allowed
          attributes.forEach((attribute) => {
            errors.push(createTagError(element, attribute, true));
          });
          break;
        case 'par':
        case 'seq':
          // These elements house other par, seq, or media elements
          if (element.elements) {
            element.elements.forEach((item) => {
              if (['par', 'seq', 'media'].indexOf(item.name) === -1) {
                const error = createTagError(element, attribute);
                error.value = item.name;
                errors.push(error);
              }
            });
          }

          break;
        case 'phoneme':
          // Attribute must be time or strength
          attributes.forEach((attribute) => {
            if (attribute === 'alphabet') {
              if (['ipa', 'x-sampa']
                .indexOf(element.attributes.alphabet) === -1) {
                errors.push(createTagError(element, attribute));
              }
            } else if (attribute !== 'ph') {
              // Invalid attribute
              errors.push(createTagError(element, attribute, true));
            }
          });
          break;
        case 'prosody':
          // Attribute must be time or strength
          attributes.forEach((attribute) => {
            if (attribute === 'rate') {
              if (!prosodyRate(element.attributes.rate)) {
                errors.push(createTagError(element, attribute));
              }
            } else if (attribute === 'pitch') {
              if (['x-low', 'low', 'medium', 'high', 'x-high'].indexOf(element.attributes.pitch) === -1) {
                // It's OK, it has to be of the form +x% or -x%
                if (element.attributes.pitch.match(/^\+[0-9]+(\.[0-9]+)?%$/g)) {
                  // Number must be less than 50
                  if (parseFloat(element.attributes.pitch) > 50) {
                    errors.push(createTagError(element, attribute));
                  }
                } else if (element.attributes.pitch.match(/^\-[0-9]+(\.[0-9]+)?%$/g)) {
                  // Number must be less than 33.3
                  if (parseFloat(element.attributes.pitch) < -33.3) {
                    errors.push(createTagError(element, attribute));
                  }
                } else {
                  errors.push(createTagError(element, attribute));
                }
              }
            } else if (attribute === 'volume') {
              if (['silent', 'x-soft', 'soft', 'medium', 'loud', 'x-loud'].indexOf(element.attributes.volume) === -1) {
                // It's OK if it's of the form +xdB or - xdB; value doesn't matter
                if (!element.attributes.volume.match(/^[+-][0-9]+(\.[0-9]+)?dB$/g)) {
                  errors.push(createTagError(element, attribute));
                }
              }
            } else {
              // Invalid attribute
              errors.push(createTagError(element, attribute, true));
            }
          });
          break;
        case 's':
          // No attributes allowed
          attributes.forEach((attribute) => {
            errors.push(createTagError(element, attribute, true));
          });
          break;
        case 'say-as':
          // Attribute must be interpret-as or format
          attributes.forEach((attribute) => {
            if (attribute === 'interpret-as') {
              if (['characters', 'spell-out', 'cardinal', 'ordinal',
                  'fraction', 'unit', 'date', 'time', 'telephone', 'expletive']
                  .indexOf(element.attributes['interpret-as']) === -1) {
                // Some attributes are platform specific
                let supported = false;
                if ((platform === 'amazon') &&
                  ['number', 'digits', 'address', 'interjection']
                  .indexOf(element.attributes['interpret-as'] !== -1)) {
                  supported = true;
                } else if ((platform === 'google') &&
                  ['bleep', 'verbatim'].indexOf(element.attributes['interpret-as'] !== -1)) {
                  supported = true;
                }

                if (!supported) {
                  errors.push(createTagError(element, attribute));
                }
              }
            } else if (attribute === 'format') {
              if (['mdy', 'dmy', 'ymd', 'md', 'dm', 'ym',
                  'my', 'd', 'm', 'y'].indexOf(element.attributes.format) === -1) {
                errors.push(createTagError(element, attribute));
              }
            } else if ((platform === 'google') && (attribute === 'detail')) {
              if (['1', '2'].indexOf(element.attributes.detail) === -1) {
                errors.push(createTagError(element, attribute));
              }
            } else {
              // Invalid attribute
              errors.push(createTagError(element, attribute, true));
            }
          });
          break;
        case 'sub':
          // alias is optional
          attributes.forEach((attribute) => {
            if (attribute !== 'alias') {
              // Invalid attribute
              errors.push(createTagError(element, attribute, true));
            }
          });
          break;
        case 'voice':
          // Attribute must be name
          attributes.forEach((attribute) => {
            if (attribute === 'name') {
              if (['Ivy', 'Joanna', 'Joey', 'Justin', 'Kendra', 'Kimberly', 'Matthew', 'Salli',
                  'Nicole', 'Russell', 'Amy', 'Brian', 'Emma', 'Aditi', 'Raveena',
                  'Hans', 'Marlene', 'Vicki', 'Conchita', 'Enrique',
                  'Carla', 'Giorgio', 'Mizuki', 'Takumi', 'Celine', 'Lea', 'Mathieu']
                .indexOf(element.attributes.name) === -1) {
                errors.push(createTagError(element, attribute));
              }
            } else {
              // Invalid attribute
              errors.push(createTagError(element, attribute, true));
            }
          });
          break;
        case 'w':
          // Attribute must be role
          attributes.forEach((attribute) => {
            if (attribute === 'role') {
              if (['amazon:VB', 'amazon:VBD', 'amazon:NN', 'amazon:SENSE_1']
                .indexOf(element.attributes.role) === -1) {
                errors.push(createTagError(element, attribute));
              }
            } else {
              // Invalid attribute
              errors.push(createTagError(element, attribute, true));
            }
          });
          break;
        default:
          break;
      }
    }
  }

  if (element.elements) {
    element.elements.forEach((item) => {
      checkForValidTags(errors, item, platform);
    });
  }
}

module.exports = {
  check: function(ssml, options) {
    let errors = [];

    try {
      let result;
      let text = ssml;
      const userOptions = options || {};
      userOptions.platform = userOptions.platform || 'all';

      if (['all', 'amazon', 'google'].indexOf(userOptions.platform) === -1) {
        errors.push({type: 'invalid platform'});
        return Promise.resolve(errors);
      }

      // This needs to be a single item wrapped in a speak tag
      let speech;
      try {
        const result = JSON.parse(convert.xml2json(text, {compact: false}));
        if (result.elements && (result.elements.length === 1) &&
          (result.elements[0].name === 'speak')) {
          speech = result.elements[0];
        } else {
          errors.push({type: 'tag', tag: 'speak'});
          return Promise.resolve(errors);
        }
      } catch (err) {
        // Special case - if we replace & with &amp; does it fix it?
        try {
          text = text.replace('&', '&amp;');
          const result = JSON.parse(convert.xml2json(text, {compact: false}));

          // OK that worked, let them know it's an & problem
          errors.push({type: 'Invalid & character'});
        } catch(err) {
          // Nope, it's some other error
          errors.push({type: 'Can\'t parse SSML'});
        }
        return Promise.resolve(errors);
      }

      // Make sure only valid tags are present
      checkForValidTags(errors, speech, userOptions.platform);

      // Count the audio files - is it more than 5?
      const audio = getAudioFiles(speech);
      if (audio.length > 5) {
        errors.push({type: 'Too many audio files'});
      }

      // If they asked to validate audio files, do that now
      if (userOptions.validateAudioFiles) {
        const promises = [];

        audio.forEach((file) => {
          promises.push(validateAudio(file));
        });

        return Promise.all(promises).then((audioErrors) => {
          audioErrors.forEach((audioError) => {
            errors = errors.concat(audioError);
          });
          return (errors.length ? errors : undefined);
        });
      }
    } catch (err) {
      console.log(err);
      errors.push({type: 'unknown error'});
    }

    // OK, looks like it's OK!
    return Promise.resolve(errors.length ? errors : undefined);
  },
};
