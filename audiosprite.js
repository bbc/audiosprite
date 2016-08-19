#!/usr/bin/env node

var fs = require('fs')
var path = require('path')
var async = require('async')
var _ = require('underscore')._
var winston = require('winston')

var optimist = require('optimist')
  .options('output', {
    alias: 'o'
  , 'default': 'output'
  , describe: 'Name for the output files.'
  })
  .options('path', {
    alias: 'u'
  , 'default': ''
  , describe: 'Path for files to be used on final JSON.'
  })
  .options('export', {
    alias: 'e'
  , 'default': 'ogg,m4a,mp3,ac3'
  , describe: 'Limit exported file types. Comma separated extension list.'
  })
  .options('format', {
    alias: 'f'
  , 'default': 'jukebox'
  , describe: 'Format of the output JSON file (jukebox, howler, createjs).'
  })
  .options('log', {
    alias: 'l'
  , 'default': 'info'
  , describe: 'Log level (debug, info, notice, warning, error).'
  })
  .options('autoplay', {
    alias: 'a'
  , 'default': null
  , describe: 'Autoplay sprite name.'
  })
  .options('loop', {
    'default': null
  , describe: 'Loop sprite name, can be passed multiple times.'
  })
  .options('silence', {
    alias: 's'
  , 'default': 0
  , describe: 'Add special "silence" track with specified duration.'
  })
  .options('gap', {
    alias: 'g'
  , 'default': 1
  , describe: 'Silence gap between sounds (in seconds).'
  })
  .options('minlength', {
    alias: 'm'
  , 'default': 0
  , describe: 'Minimum sound duration (in seconds).'
  })
  .options('bitrate', {
    alias: 'b'
  , 'default': 128
  , describe: 'Bit rate. Works for: ac3, mp3, mp4, m4a, ogg.'
  })
  .options('vbr', {
    alias: 'v'
  , 'default': -1
  , describe: 'VBR [0-9]. Works for: mp3. -1 disables VBR.'
  })
  .options('samplerate', {
    alias: 'r'
  , 'default': 44100
  , describe: 'Sample rate.'
  })
  .options('channels', {
    alias: 'c'
  , 'default': 1
  , describe: 'Number of channels (1=mono, 2=stereo).'
  })
  .options('rawparts', {
    alias: 'p'
  , 'default': ''
  , describe: 'Include raw slices(for Web Audio API) in specified formats.'
  })
  .options('rawpartnames', {
    alias: 'n'
  , 'default': null
  , describe: 'Maintain original file names for raw files.'
  })
  .options('help', {
    alias: 'h'
  , describe: 'Show this help message.'
  })

var argv = optimist.argv

winston.remove(winston.transports.Console)
winston.add(winston.transports.Console, {
  colorize: true
, level: argv.log
, handleExceptions: false
})
winston.debug('Parsed arguments', argv)


var BIT_RATE = parseInt(argv.bitrate, 10)
var SAMPLE_RATE = parseInt(argv.samplerate, 10)
var NUM_CHANNELS = parseInt(argv.channels, 10)
var GAP_SECONDS = parseFloat(argv.gap)
var MINIMUM_SOUND_LENGTH = parseFloat(argv.minlength)
var VBR = parseInt(argv.vbr, 10)
var fileNames = [];

var loops = argv.loop ? [].concat(argv.loop) : []

var files = _.uniq(argv._)

if (argv.help || !files.length) {
  if (!argv.help) {
    winston.error('No input files specified.')
  }
  winston.info('Usage: audiosprite [options] file1.mp3 file2.mp3 *.wav')
  winston.info(optimist.help())
  process.exit(1)
}

// make sure output directory exists
var outputDir = path.dirname(argv.output)
if (!fs.existsSync(outputDir)) {
  require('mkdirp').sync(outputDir)
}

var offsetCursor = 0
var wavArgs = ['-ar', SAMPLE_RATE, '-ac', NUM_CHANNELS, '-f', 's16le']
var tempFile = mktemp('audiosprite')

winston.debug('Created temporary file', { file: tempFile })

var json = {
  resources: []
, spritemap: {}
}

spawn('ffmpeg', ['-version']).on('exit', function(code) {
  if (code) {
    winston.error('ffmpeg was not found on your path')
    process.exit(1)
  }
  if (argv.silence) {
    json.spritemap.silence = {
      start: 0
    , end: argv.silence
    , loop: true
    }
    if (!argv.autoplay) {
      json.autoplay = 'silence'
    }
    appendSilence(argv.silence + GAP_SECONDS, tempFile, processFiles)
  } else {
    processFiles()
  }
})


function mktemp(prefix) {
  var tmpdir = require('os').tmpDir() || '.'
  return path.join(tmpdir, prefix + '.' + Math.random().toString().substr(2))
}

function spawn(name, opt) {
  winston.debug('Spawn', { cmd: [name].concat(opt).join(' ') })
  return require('child_process').spawn(name, opt)
}

function pad(num, size) {
  var str = num.toString()
  while (str.length < size) {
    str = '0' + str
  }
  return str
}

function makeRawAudioFile(src, cb) {
  var dest = mktemp('audiosprite')

  winston.debug('Start processing', { file: src})

  fs.exists(src, function(exists) {
    if (exists) {
      var ffmpeg = spawn('ffmpeg', ['-i', path.resolve(src)]
        .concat(wavArgs).concat('pipe:'))
      ffmpeg.stdout.pipe(fs.createWriteStream(dest, {flags: 'w'}))
      ffmpeg.on('exit', function(code, signal) {
        if (code) {
          return cb({
            msg: 'File could not be added',
            file: src,
            retcode: code,
            signal: signal
          })
        }
        cb(null, dest)
      })
    }
    else {
      cb({ msg: 'File does not exist', file: src })
    }
  })
}

function appendFile(name, src, dest, cb) {
  var size = 0
  var reader = fs.createReadStream(src)
  var writer = fs.createWriteStream(dest, {
    flags: 'a'
  })
  reader.on('data', function(data) {
    size += data.length
  })
  reader.on('close', function() {
    var originalDuration = size / SAMPLE_RATE / NUM_CHANNELS / 2
    winston.info('File added OK', { file: src, duration: originalDuration })
    var extraDuration = Math.max(0, MINIMUM_SOUND_LENGTH - originalDuration)
    var duration = originalDuration + extraDuration
    json.spritemap[name] = {
      start: offsetCursor
    , end: offsetCursor + duration
    , loop: name === argv.autoplay || loops.indexOf(name) !== -1
    }
    offsetCursor += originalDuration
    appendSilence(extraDuration + Math.ceil(duration) - duration + GAP_SECONDS, dest, cb)
  })
  reader.pipe(writer)
}

function appendSilence(duration, dest, cb) {
  var buffer = new Buffer(Math.round(SAMPLE_RATE * 2 * NUM_CHANNELS * duration))
  buffer.fill(0)
  var writeStream = fs.createWriteStream(dest, { flags: 'a' })
  writeStream.end(buffer)
  writeStream.on('close', function() {
    winston.info('Silence gap added', { duration: duration })
    offsetCursor += duration
    cb()
  })
}

function exportFile(src, dest, ext, opt, store, cb) {
  var outfile = dest + '.' + ext
  spawn('ffmpeg',['-y', '-ar', SAMPLE_RATE, '-ac', NUM_CHANNELS, '-f', 's16le', '-i', src]
      .concat(opt).concat(outfile))
    .on('exit', function(code, signal) {
      if (code) {
        return cb({
          msg: 'Error exporting file',
          format: ext,
          retcode: code,
          signal: signal
        })
      }
      if (ext === 'aiff') {
        exportFileCaf(outfile, dest + '.caf', function(err) {
          if (!err && store) {
            json.resources.push(dest + '.caf')
          }
          fs.unlinkSync(outfile)
          cb()
        })
      } else {
        winston.info('Exported ' + ext + ' OK', { file: outfile })
        if (store) {
          json.resources.push(outfile)
        }
        cb()
      }
    })
}

function exportFileCaf(src, dest, cb) {
  if (process.platform !== 'darwin') {
    return cb(true)
  }
  spawn('afconvert', ['-f', 'caff', '-d', 'ima4', src, dest])
    .on('exit', function(code, signal) {
      if (code) {
        return cb({
          msg: 'Error exporting file',
          format: 'caf',
          retcode: code,
          signal: signal
        })
      }
      winston.info('Exported caf OK', { file: dest })
      return cb()
    })
}

function processFiles() {
  var formats = {
    aiff: []
  , wav: []
  , ac3: ['-acodec', 'ac3', '-ab', BIT_RATE + 'k']
  , mp3: ['-ar', SAMPLE_RATE, '-f', 'mp3']
  , mp4: ['-ab', BIT_RATE + 'k']
  , m4a: ['-ab', BIT_RATE + 'k']
  , ogg: ['-acodec', 'libvorbis', '-f', 'ogg', '-ab', BIT_RATE + 'k']
  }

  if (VBR >= 0 && VBR <= 9) {
    formats.mp3 = formats.mp3.concat(['-aq', VBR])
  }
  else {
    formats.mp3 = formats.mp3.concat(['-ab', BIT_RATE + 'k'])
  }

  if (argv.export.length) {
    formats = argv.export.split(',').reduce(function(memo, val) {
      if (formats[val]) {
        memo[val] = formats[val]
      }
      return memo
    }, {})
  }

  var rawparts = argv.rawparts.length ? argv.rawparts.split(',') : null
  var i = 0
  async.forEachSeries(files, function(file, cb) {
    i++
    makeRawAudioFile(file, function(err, tmp) {
      if (err) {
        return cb(err)
      }

      function tempProcessed() {
        fs.unlinkSync(tmp)
        cb()
      }

      var name = path.basename(file).replace(/\.[a-zA-Z0-9]+$/, '')
      appendFile(name, tmp, tempFile, function(err) {
        fileNames.push(name);
        if (rawparts != null ? rawparts.length : void 0) {
        async.forEachSeries(rawparts, function(ext, cb) {
          winston.debug('Start export slice', { name: name, format: ext, i: i })
          winston.info('File: ' + name)
          if (argv.rawpartnames) {
            exportFile(tmp, name, ext, formats[ext], false, cb)
          }
          else {
            exportFile(tmp, argv.output + '_' + pad(i, 3), ext, formats[ext], false, cb)
          }
          }, tempProcessed)
        } else {
          tempProcessed()
        }
      })
    })
  }, function(err) {
    if (err) {
      winston.error('Error adding file', err)
      process.exit(1)
    }
    async.forEachSeries(Object.keys(formats), function(ext, cb) {
      winston.debug('Start export', { format: ext })
      exportFile(tempFile, argv.output, ext, formats[ext], true, cb)
    }, function(err) {
      if (err) {
        winston.error('Error exporting file', err)
        process.exit(1)
      }
      if (argv.autoplay) {
        json.autoplay = argv.autoplay
      }

      json.resources = json.resources.map(function(e) {
        return argv.path ? path.join(argv.path, path.basename(e)) : e
      })

      var finalJson = {}
      var individualJson = {}

      switch (argv.format) {

        case 'howler':
          finalJson.urls = [].concat(json.resources)
          finalJson.sprite = {}
          for (var sn in json.spritemap) {
            var spriteInfo = json.spritemap[sn]
            finalJson.sprite[sn] = [spriteInfo.start * 1000, (spriteInfo.end - spriteInfo.start) * 1000]
            if (spriteInfo.loop) {
              finalJson.sprite[sn].push(true)
            }
          }
          break

        case 'createjs':
          finalJson.src = json.resources[0]
          finalJson.data = {audioSprite: []}
          for (var sn in json.spritemap) {
            var spriteInfo = json.spritemap[sn]
            finalJson.data.audioSprite.push({
              id: sn,
              startTime: spriteInfo.start * 1000,
              duration: (spriteInfo.end - spriteInfo.start) * 1000
            })
          }
          break

        case 'default': // legacy support
        default:
          finalJson = json
          break
      }

      var jsonfile = argv.output + '.json'
      fs.writeFileSync(jsonfile, JSON.stringify(finalJson, null, 2))
      winston.info('Exported json OK', { file: jsonfile })
      fs.unlinkSync(tempFile)
      winston.info('All done')
    })
  })
}
