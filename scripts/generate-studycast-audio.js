require('dotenv').config();
const { ensureEpisodeAudio, PODCAST_EPISODE_IDS } = require('../lib/studycastPodcast');

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error(
      'ERROR: GEMINI_API_KEY is not set. Configure GEMINI_API_KEY in .env or Settings > Secrets to generate dual-speaker Studycast MP3 audio.'
    );
    process.exit(1);
  }

  for (const id of PODCAST_EPISODE_IDS) {
    console.log(`Generating/checking cached podcast audio for ${id}...`);
    const info = await ensureEpisodeAudio(id);
    console.log(
      `Ready ${id}: ${info.filePath} (${info.duration_seconds}s / ${info.duration_label})`
    );
  }
}

main().catch((err) => {
  console.error('Generation failed:', err);
  process.exit(1);
});
