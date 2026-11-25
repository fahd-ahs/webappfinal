const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { GoogleGenAI } = require('@google/genai');

const execFileAsync = promisify(execFile);

const AUDIO_DIR = path.join(__dirname, '..', 'data', 'audio');
const PODCAST_EPISODE_IDS = new Set(['sc-8', 'sc-7']);

const MAYA_STYLE_CURIOUS =
  'Warm, expressive, naturally curious female podcast co-host with upbeat conversational energy';
const MAYA_STYLE_REACT =
  'Engaged, thoughtful female podcast co-host reacting naturally with warmth and clarity';
const ARJUN_STYLE_EXPLAIN =
  'Friendly, confident, knowledgeable male educator explaining concepts clearly with relatable analogies';
const ARJUN_STYLE_BANTER =
  'Warm, witty male podcast co-host with natural pacing, light humor, and conversational emphasis';

const PODCAST_SCRIPTS = {
  'sc-8': {
    episodeId: 'sc-8',
    title: 'Organic Chemistry: Hydrocarbons',
    segments: [
      {
        id: 'intro-saturation',
        parts: [
          {
            speaker: 'Maya',
            style: MAYA_STYLE_CURIOUS,
            text: "Hey everyone, welcome back to Studycast! <breath> I'm Maya, and today we're diving into Ms. Preethi's Organic Chemistry session on hydrocarbons.",
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_BANTER,
            text: "And I'm Arjun. |Yeah| you know, whenever people hear the word hydrocarbons, it sounds super intimidating, right? Like some alien rocket fuel.",
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: '<laugh> Totally! Until you realize the name literally gives away the whole secret.',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: "Exactly! Hydro means hydrogen, carbon means carbon. They're compounds built exclusively from those two elements. And yet they're everywhere—the LPG cooking your dinner, the wax in a birthday candle, even the polyethylene in a milk pouch.",
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_CURIOUS,
            text: 'Wait—how can just two elements make thousands of completely different things? That feels slightly unfair to the rest of the periodic table.',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: "It's carbon's superpower: tetravalency and catenation. Carbon has four valence bonds to play with, and it loves linking to other carbon atoms in chains, branches, and rings. Now, the biggest divide in hydrocarbons is saturated versus unsaturated.",
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: '|Mhm|, like a saturated sponge that cannot hold another drop of water?',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: "Spot on! Think of a crowded metro train where every single seat is taken. In saturated hydrocarbons—which we call alkanes—every carbon-carbon bond is a single sigma bond, so each carbon holds the maximum number of hydrogens possible. Unsaturated hydrocarbons—alkenes and alkynes—have double or triple bonds, meaning they still have room to add more atoms.",
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_CURIOUS,
            text: 'Okay, walk me through the three big families and their general formulae, because students mix these up under exam pressure all the time.',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: 'Sure thing. Start with alkanes—single bonds only. Their general formula is C n H 2n plus 2. So for one carbon, n equals 1, you get methane, CH4. For two carbons, ethane, C2H6.',
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: 'Got it. And when you remove two hydrogens to create a carbon-carbon double bond, you jump to alkenes?',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: "Right! Alkenes have at least one carbon-carbon double bond, and their formula drops by two hydrogens to C n H 2n. Take off two more hydrogens and form a triple bond, and you're in alkyne territory: C n H 2n minus 2.",
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_CURIOUS,
            text: 'Hold on—quick trap question! What is the formula for methene?',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_BANTER,
            text: '<laugh> Nice try, Maya! Trick question—methene does not exist! You need at least two carbon atoms to form a carbon-carbon double or triple bond. So alkenes and alkynes always start at n equals 2: ethene and ethyne.',
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: '|Yeah|, teachers love catching people on that! What about IUPAC naming—how do you keep prefixes and numbering straight?',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: 'Count the longest continuous carbon chain first: one is meth, two eth, three prop, four but, five pent. Suffixes match the family: -ane, -ene, or -yne. And here is the golden rule: if there is a double or triple bond, always number the chain from the end closest to that multiple bond, so it gets the lowest possible locant number—like but-1-ene, not but-3-ene.',
          },
        ],
      },
      {
        id: 'structure-properties',
        parts: [
          {
            speaker: 'Maya',
            style: MAYA_STYLE_CURIOUS,
            text: "Let's zoom in on geometry. When you switch from single to double to triple bonds, the 3D shape changes completely, doesn't it?",
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: "It really does! In methane or ethane, carbon is sp3 hybridized—tetrahedral, with bond angles around 109.5 degrees, and free rotation around that single sigma bond. In ethene, sp2 hybridization flattens the molecule into a trigonal planar triangle at 120 degrees, locking rotation because of the pi bond. And ethyne? Pure sp hybridization—dead straight, linear, 180 degrees!",
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: 'Wait—students often assume a double bond must be way harder to break, so alkenes should be LESS reactive than alkanes. Is that true?',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: "Actually, that's one of the biggest misconceptions in Class 12! While the total double bond is shorter, its second bond—the sideways-overlapping pi bond—is weaker and exposed above and below the plane. So alkanes are famously sluggish—we call them paraffins, from 'little affinity'—only reacting via substitution under harsh UV light or combustion.",
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: 'Whereas alkenes and alkynes happily open up that pi bond for addition reactions!',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: 'Exactly! Hydrogenation adds H2 across the double bond to turn vegetable oil into solid fat. And in the lab, you can spot an unsaturated hydrocarbon instantly with the bromine water test: reddish-brown bromine water turns completely colorless as it adds across the double or triple bond. Alkanes leave it brown.',
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_CURIOUS,
            text: "Before we wrap up, connect this to the real world and what's definitely showing up on exam papers.",
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: "Look around! Methane powers CNG buses and burns cleanly in combustion reactions, propane and butane fill LPG cylinders, ethene is the natural hormone that ripens bananas and builds polythene, and ethyne—or acetylene—burns with oxygen above 3,000 degrees Celsius in welding torches.",
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: 'Awesome. So for quick exam revision: first, remember the bromine water decolorization test distinguishes saturated from unsaturated hydrocarbons.',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: 'Second, always number your IUPAC chain to give the double or triple bond the lowest locant—and remember alkenes and alkynes start at n equals 2.',
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: 'And third, balance your complete combustion equations cleanly—hydrocarbon plus oxygen always yields CO2 and water!',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_BANTER,
            text: 'Nailed it! <breath> Keep reviewing those structures, and we will catch you in the next Studycast!',
          },
        ],
      },
    ],
  },

  'sc-7': {
    episodeId: 'sc-7',
    title: 'Trigonometry Master Class',
    segments: [
      {
        id: 'intro-radians',
        parts: [
          {
            speaker: 'Maya',
            style: MAYA_STYLE_CURIOUS,
            text: "Welcome back to Studycast, everyone! I'm Maya, and today Arjun and I are tackling Dr. Sunita Rao's Trigonometry Master Class.",
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_BANTER,
            text: "Hey, I'm Arjun! <breath> Now Maya, be honest—when you first saw sine, cosine, and tangent in school, did it feel like someone just dumped a Greek alphabet soup onto triangles?",
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: '<laugh> Oh, completely! Until I learned that trigonometry literally means "triangle measurement," and it powers everything from GPS satellites to sound waves.',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: 'Right! And in Class 12, before you even touch inverse trig or calculus, you have to move comfortably beyond degrees into radians. Think about it: 360 degrees in a circle is actually pretty arbitrary—historians trace it back to ancient calendars near 365 days.',
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_CURIOUS,
            text: 'Okay, so why are radians considered more natural?',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: 'Imagine taking the radius of a circle like a piece of string and laying it along the curved edge. The angle you carve out when arc length equals one radius is exactly one radian! Since the full circumference is 2 pi r, a full circle is 2 pi radians, and half a circle—180 degrees—equals pi radians. Calculus and physics love radians because derivatives stay clean without messy conversion factors.',
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: '|Mhm|, so to convert degrees to radians, you just multiply by pi over 180!',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: "Spot on. Now let's bridge right triangles to the unit circle. In a right triangle, SOH-CAH-TOA gives sine as opposite over hypotenuse, cosine as adjacent over hypotenuse, and tangent as opposite over adjacent—which is simply sine theta divided by cosine theta.",
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_CURIOUS,
            text: 'Wait—that works great for acute angles under 90 degrees, because a right triangle cannot have a 120-degree or 240-degree angle! How do those even have a sine?',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: 'That is why the unit circle is pure magic! Draw a circle of radius 1 centered at the origin of an x-y graph. Start at the positive x-axis and rotate counterclockwise by angle theta. Wherever your point lands on the circle, its x-coordinate IS cosine theta, and its y-coordinate IS sine theta!',
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: '<gasp> Oh! Because the hypotenuse is 1, adjacent is just x, and opposite is just y! Suddenly angles in all four quadrants make total sense!',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: 'Yes! And that explains the famous ASTC sign rule—All Students Take Calculus. In Quadrant 1, x and y are both positive, so everything is positive. In Quadrant 2, only y—sine—is positive. In Quadrant 3, both are negative, so their ratio, tangent, is positive. And in Quadrant 4, only x—cosine—is positive.',
          },
        ],
      },
      {
        id: 'identities-values-periodicity',
        parts: [
          {
            speaker: 'Maya',
            style: MAYA_STYLE_CURIOUS,
            text: 'Wait—if every point on the unit circle has coordinates cosine theta and sine theta, and the circle equation is x squared plus y squared equals 1...',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_BANTER,
            text: '|Yeah!| Go ahead, say it!',
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: 'Then sine squared theta plus cosine squared theta equals 1 is literally just the Pythagorean theorem on the unit circle!',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: 'Exactly! Divide that single identity by cosine squared theta and you get 1 plus tan squared equals sec squared. Divide by sine squared theta and you get 1 plus cot squared equals cosec squared. No rote memorization needed!',
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_CURIOUS,
            text: 'What about standard values for 0, 30, 45, 60, and 90 degrees—any neat mental shortcut?',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: 'My favorite trick: write 0, 1, 2, 3, 4, take the square root of each, and divide by 2! That gives sine: 0, 1/2, root 2 over 2, root 3 over 2, and 1. For cosine, just reverse the list! And for periodicity, imagine riding a Ferris wheel: after every full 2 pi rotation you are back at the same height, so sine and cosine repeat every 2 pi, whereas tangent repeats twice as fast, every pi.',
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_CURIOUS,
            text: "Alright, let's hit real-world uses and the classic mistakes that cost marks on tests.",
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: 'In real life, surveyors measure skyscraper heights with tangent, electrical engineers model alternating current with sine waves, and game developers rotate 3D characters using unit-circle coordinates. Now, for classic mistakes—number one: assuming sine of A plus B equals sine A plus sine B. Nope! You cannot distribute sine like multiplication.',
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: '<laugh> Oh, I have definitely seen someone write sine 90 equals sine 30 plus sine 60 and wonder why 1 did not equal 1.366!',
          },
          {
            speaker: 'Arjun',
            style: ARJUN_STYLE_EXPLAIN,
            text: 'Right! Also, watch calculator mode—degrees versus radians—and remember that tan 90 degrees, or pi over 2, is undefined because cosine is zero in the denominator. Finally, two killer exam tips: first, check your quadrant sign with ASTC before locking in an answer. Second, whenever you get stuck proving an identity, convert everything into sine and cosine and simplify.',
          },
          {
            speaker: 'Maya',
            style: MAYA_STYLE_REACT,
            text: 'Such a clean toolkit—unit circle, ASTC, and converting to sine and cosine. Thanks, Arjun, and good luck with practice everyone!',
          },
        ],
      },
    ],
  },
};

const durationCache = new Map();
const inFlightGenerations = new Map();

function ensureAudioDir() {
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }
}

function getEpisodeAudioPath(episodeId) {
  return path.join(AUDIO_DIR, `${episodeId}.mp3`);
}

function formatDurationLabel(totalSeconds) {
  const sec = Math.max(1, Math.round(Number(totalSeconds) || 0));
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

async function probeAudioDurationSeconds(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const parsed = parseFloat(String(stdout || '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Unable to determine audio duration for ${filePath}`);
  }
  return Math.round(parsed);
}

function getCachedAudioInfoSync(episodeId) {
  if (!PODCAST_EPISODE_IDS.has(episodeId)) return null;
  const filePath = getEpisodeAudioPath(episodeId);
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size < 1024) return null;

  const cached = durationCache.get(episodeId);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return {
      filePath,
      duration_seconds: cached.duration_seconds,
      duration_label: formatDurationLabel(cached.duration_seconds),
      audio_url: `/api/studycast/${episodeId}/audio`,
      has_audio: true,
    };
  }
  return {
    filePath,
    duration_seconds: null,
    duration_label: null,
    audio_url: `/api/studycast/${episodeId}/audio`,
    has_audio: true,
  };
}

async function getCachedAudioInfo(episodeId) {
  const syncInfo = getCachedAudioInfoSync(episodeId);
  if (!syncInfo) return null;
  if (syncInfo.duration_seconds) return syncInfo;

  const stat = fs.statSync(syncInfo.filePath);
  const durationSeconds = await probeAudioDurationSeconds(syncInfo.filePath);
  durationCache.set(episodeId, { mtimeMs: stat.mtimeMs, duration_seconds: durationSeconds });
  return {
    ...syncInfo,
    duration_seconds: durationSeconds,
    duration_label: formatDurationLabel(durationSeconds),
  };
}

function getGeminiClient() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const PRIMARY_TTS_MODEL = 'gemini-3.8-flash-tts';
const FALLBACK_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
let primaryQuotaExhaustedUntil = 0;

function formatPartTextForModel(part, model) {
  let spoken = `${part.speaker}: ${part.text}`;
  if (model !== PRIMARY_TTS_MODEL) {
    spoken = spoken
      .replace(/<laugh>/gi, 'Haha,')
      .replace(/<gasp>/gi, 'Whoa,')
      .replace(/<breath>/gi, '')
      .replace(/\|([^|]+)\|/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  return spoken;
}

async function callGeminiMultiSpeakerTts(ai, model, segment) {
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: segment.parts.map((part) => ({
          text: formatPartTextForModel(part, model),
          speechMetadata: {
            speaker: part.speaker,
            style: part.style,
          },
        })),
      },
    ],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            {
              speaker: 'Maya',
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Kore' },
              },
            },
            {
              speaker: 'Arjun',
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Puck' },
              },
            },
          ],
        },
      },
    },
  });

  const parts = response.candidates?.[0]?.content?.parts || [];
  const audioPart = parts.find((p) => p.inlineData?.data);
  if (!audioPart?.inlineData?.data) {
    throw new Error(`Gemini TTS (${model}) returned no audio data for segment "${segment.id}"`);
  }
  const buf = Buffer.from(audioPart.inlineData.data, 'base64');
  if (buf.length <= 44) {
    throw new Error(`Gemini TTS (${model}) returned an empty audio clip for segment "${segment.id}"`);
  }
  return buf;
}

async function synthesizeSegmentWav(ai, segment) {
  const modelsToTry =
    Date.now() < primaryQuotaExhaustedUntil
      ? [FALLBACK_TTS_MODEL]
      : [PRIMARY_TTS_MODEL, FALLBACK_TTS_MODEL];

  let lastError;
  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await callGeminiMultiSpeakerTts(ai, model, segment);
      } catch (err) {
        lastError = err;
        const status = err?.status;
        if (model === PRIMARY_TTS_MODEL && (status === 429 || status === 403 || status === 404)) {
          console.warn(
            `[Studycast] ${PRIMARY_TTS_MODEL} unavailable (HTTP ${status}); falling back to ${FALLBACK_TTS_MODEL} for segment "${segment.id}".`
          );
          if (status === 429) {
            primaryQuotaExhaustedUntil = Date.now() + 60 * 60 * 1000;
          }
          break;
        }
        if (attempt < 2 && (status === 500 || status === 503)) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }
  }
  throw lastError;
}

async function transcodeSegmentsToMp3(wavBuffers, outputMp3Path) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycast-'));
  try {
    const segPaths = [];
    for (let i = 0; i < wavBuffers.length; i++) {
      const segPath = path.join(tmpDir, `seg-${i}.wav`);
      fs.writeFileSync(segPath, wavBuffers[i]);
      segPaths.push(segPath);
    }

    // Build ffmpeg filter_complex: resample each clip cleanly, insert short natural 180ms pause between acts, normalize loudness
    const inputs = [];
    const filterParts = [];
    const concatRefs = [];

    segPaths.forEach((p, idx) => {
      inputs.push('-i', p);
      filterParts.push(`[${idx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono[a${idx}]`);
      concatRefs.push(`[a${idx}]`);
      if (idx < segPaths.length - 1) {
        filterParts.push(`anullsrc=r=44100:cl=mono,atrim=duration=0.18[gap${idx}]`);
        concatRefs.push(`[gap${idx}]`);
      }
    });

    const totalConcatInputs = concatRefs.length;
    const filterComplex = [
      ...filterParts,
      `${concatRefs.join('')}concat=n=${totalConcatInputs}:v=0:a=1[joined]`,
      `[joined]loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
    ].join(';');

    const tmpMp3 = `${outputMp3Path}.tmp.mp3`;
    await execFileAsync('ffmpeg', [
      '-y',
      ...inputs,
      '-filter_complex',
      filterComplex,
      '-map',
      '[out]',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      '-ac',
      '1',
      tmpMp3,
    ]);

    fs.renameSync(tmpMp3, outputMp3Path);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function ensureEpisodeAudio(episodeId) {
  if (!PODCAST_EPISODE_IDS.has(episodeId)) {
    const err = new Error('This episode uses standard playback');
    err.status = 404;
    throw err;
  }

  const cached = await getCachedAudioInfo(episodeId);
  if (cached) return cached;

  if (inFlightGenerations.has(episodeId)) {
    return inFlightGenerations.get(episodeId);
  }

  const job = (async () => {
    const ai = getGeminiClient();
    if (!ai) {
      const err = new Error(
        'Audio generation requires GEMINI_API_KEY (Google Gemini gemini-3.8-flash-tts) configured in Settings > Secrets or backend environment variables.'
      );
      err.status = 424;
      err.code = 'MISSING_AUDIO_API_KEY';
      throw err;
    }

    ensureAudioDir();
    const script = PODCAST_SCRIPTS[episodeId];
    const wavBuffers = [];
    for (const segment of script.segments) {
      const wav = await synthesizeSegmentWav(ai, segment);
      wavBuffers.push(wav);
    }

    const outPath = getEpisodeAudioPath(episodeId);
    await transcodeSegmentsToMp3(wavBuffers, outPath);

    const stat = fs.statSync(outPath);
    const durationSeconds = await probeAudioDurationSeconds(outPath);
    durationCache.set(episodeId, { mtimeMs: stat.mtimeMs, duration_seconds: durationSeconds });

    return {
      filePath: outPath,
      duration_seconds: durationSeconds,
      duration_label: formatDurationLabel(durationSeconds),
      audio_url: `/api/studycast/${episodeId}/audio`,
      has_audio: true,
    };
  })();

  inFlightGenerations.set(episodeId, job);
  try {
    return await job;
  } finally {
    inFlightGenerations.delete(episodeId);
  }
}

async function warmupPodcastCache() {
  if (!(process.env.GEMINI_API_KEY || '').trim()) {
    return { skipped: true, reason: 'GEMINI_API_KEY not configured' };
  }
  const results = {};
  for (const episodeId of PODCAST_EPISODE_IDS) {
    try {
      results[episodeId] = await ensureEpisodeAudio(episodeId);
    } catch (err) {
      console.error(`[Studycast] Failed to pre-generate audio for ${episodeId}:`, err.message);
      results[episodeId] = { error: err.message };
    }
  }
  return results;
}

module.exports = {
  PODCAST_EPISODE_IDS,
  PODCAST_SCRIPTS,
  ensureEpisodeAudio,
  getCachedAudioInfo,
  getCachedAudioInfoSync,
  getEpisodeAudioPath,
  formatDurationLabel,
  warmupPodcastCache,
};
