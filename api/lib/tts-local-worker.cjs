const { readFileSync } = require('node:fs')
const path = require('node:path')

const { OfflineTts, writeWave } = require('sherpa-onnx-node')

const [directory, speaker, outputPath] = process.argv.slice(2)
const asset = file => path.join(directory, file)
const tts = new OfflineTts({
  model: {
    vits: { model: asset('model.onnx'), lexicon: asset('lexicon.txt'), tokens: asset('tokens.txt') },
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  },
  ruleFsts: ['phone.fst', 'date.fst', 'number.fst'].map(asset).join(','),
  maxNumSentences: 1,
})
const audio = tts.generate({ text: readFileSync(0, 'utf8'), sid: Number(speaker), speed: 1 })
if (!audio.samples.length || !writeWave(outputPath, audio)) process.exitCode = 1
