require('dotenv').config();

const { spawn } = require('node:child_process');
const prism = require('prism-media');
const WebSocket = require('ws');
const ffmpegPath = require('ffmpeg-static');

const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} = require('discord.js');

const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
  EndBehaviorType,
  AudioPlayerStatus,
} = require('@discordjs/voice');

const DISCORD_TOKEN = String(process.env.DISCORD_TOKEN || '').trim();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();

const INPUT_COOLDOWN_MS = 1500;
const MIN_INPUT_BYTES = 24000;
const SILENCE_DURATION_MS = 700;

const HEBREW_ONLY_INSTRUCTIONS = [
  'You are a Discord voice bot.',
  'The conversation language is Hebrew only.',
  'Always speak and reply only in Hebrew.',
  'Never speak Arabic.',
  'Never switch to Arabic, English, or any other language, even if the audio is noisy, unclear, or mixed.',
  'If the user speaks in another language, still answer only in Hebrew.',
  'If the audio is unclear, ask the user to repeat, but do it in Hebrew.',
  'Keep replies short, clear, warm, and conversational.',
].join(' ');

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

if (!ffmpegPath) {
  console.error('ffmpeg-static was not found.');
  process.exit(1);
}

const guildSessions = new Map();

function parseAllowedUserIds() {
  const multiIds = String(process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const singleId = String(process.env.ALLOWED_USER_ID || '').trim();

  const allIds = [...multiIds];

  if (singleId) {
    allIds.push(singleId);
  }

  return new Set(allIds);
}

const allowedUserIds = parseAllowedUserIds();

function isAllowedUser(userId) {
  if (allowedUserIds.size === 0) {
    return true;
  }

  return allowedUserIds.has(userId);
}

function stopCurrentOutput(session) {
  if (!session.currentOutput) return;

  try {
    session.player.stop(true);
  } catch {}

  try {
    session.currentOutput.encoder.stdin.destroy();
  } catch {}

  try {
    session.currentOutput.encoder.kill('SIGKILL');
  } catch {}

  session.currentOutput = null;
  session.lastOutputAt = Date.now();
}

function finishAssistantAudio(session, responseId) {
  if (!session.currentOutput) return;
  if (responseId && session.currentOutput.responseId !== responseId) return;
  if (session.currentOutput.closing) return;

  session.currentOutput.closing = true;
  session.lastOutputAt = Date.now();

  try {
    session.currentOutput.encoder.stdin.end();
  } catch {}
}

function createAssistantOutput(session, responseId) {
  stopCurrentOutput(session);

  const encoder = spawn(ffmpegPath, [
    '-loglevel',
    'error',
    '-f',
    's16le',
    '-ar',
    '24000',
    '-ac',
    '1',
    '-i',
    'pipe:0',
    '-c:a',
    'libopus',
    '-b:a',
    '64k',
    '-application',
    'audio',
    '-frame_duration',
    '20',
    '-f',
    'ogg',
    'pipe:1',
  ]);

  encoder.on('error', (error) => {
    console.error('Assistant output encoder error:', error);
  });

  encoder.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) {
      console.error('Assistant output ffmpeg stderr:', text);
    }
  });

  encoder.stdin.on('error', () => {});
  encoder.stdout.on('error', () => {});

  encoder.on('close', () => {
    if (
      session.currentOutput &&
      session.currentOutput.responseId === responseId
    ) {
      session.currentOutput = null;
    }
  });

  const resource = createAudioResource(encoder.stdout, {
    inputType: StreamType.OggOpus,
  });

  session.player.play(resource);

  session.currentOutput = {
    responseId,
    encoder,
    closing: false,
  };
}

function appendAssistantAudioDelta(session, responseId, deltaBase64) {
  if (!deltaBase64) return;

  if (
    !session.currentOutput ||
    session.currentOutput.responseId !== responseId
  ) {
    createAssistantOutput(session, responseId);
  }

  try {
    const audioBuffer = Buffer.from(deltaBase64, 'base64');
    session.currentOutput.encoder.stdin.write(audioBuffer);
  } catch (error) {
    console.error('Failed to append assistant audio delta:', error);
  }
}

function handleRealtimeEvent(session, event) {
  switch (event.type) {
    case 'session.created':
      console.log(`Realtime session created for guild ${session.guildId}`);
      break;

    case 'session.updated':
      console.log(`Realtime session updated for guild ${session.guildId}`);
      break;

    case 'input_audio_buffer.speech_started':
      console.log(`OpenAI detected speech start in guild ${session.guildId}`);
      stopCurrentOutput(session);
      break;

    case 'input_audio_buffer.speech_stopped':
      console.log(`OpenAI detected speech stop in guild ${session.guildId}`);
      break;

    case 'input_audio_buffer.committed':
      console.log(`Audio committed in guild ${session.guildId}`);
      break;

    case 'conversation.item.input_audio_transcription.completed':
      if (event.transcript) {
        console.log(`User transcript [${session.guildId}]: ${event.transcript}`);
      }
      break;

    case 'response.created':
      console.log(`Response created in guild ${session.guildId}`);
      break;

    case 'response.output_audio.delta':
      appendAssistantAudioDelta(session, event.response_id, event.delta);
      break;

    case 'response.output_audio.done':
      finishAssistantAudio(session, event.response_id);
      break;

    case 'response.done':
      finishAssistantAudio(session, event.response?.id || null);
      break;

    case 'error':
      console.error('OpenAI Realtime error event:', event);
      break;

    default:
      break;
  }
}

function createRealtimeSocket(session) {
  return new Promise((resolve, reject) => {
    let opened = false;

    const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime', {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    });

    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('Timed out while connecting to OpenAI Realtime.'));
    }, 15000);

    session.ws = ws;

    ws.once('open', () => {
      opened = true;
      clearTimeout(timeout);
      session.wsReady = true;

      ws.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            model: 'gpt-realtime',
            instructions: HEBREW_ONLY_INSTRUCTIONS,
            max_response_output_tokens: 120,
            audio: {
              input: {
                format: {
                  type: 'audio/pcm',
                  rate: 24000,
                },
                noise_reduction: {
                  type: 'near_field',
                },
                transcription: {
                  model: 'gpt-4o-mini-transcribe',
                  language: 'he',
                  prompt:
                    'The speaker is speaking Hebrew. Expect Hebrew words, Hebrew names, and short Hebrew phrases.',
                },
                turn_detection: null,
              },
              output: {
                format: {
                  type: 'audio/pcm',
                  rate: 24000,
                },
                voice: 'marin',
                speed: 0.96,
              },
            },
            output_modalities: ['audio'],
          },
        }),
      );

      console.log(`OpenAI Realtime connected for guild ${session.guildId}`);
      resolve();
    });

    ws.on('message', (message) => {
      try {
        const event = JSON.parse(message.toString());
        handleRealtimeEvent(session, event);
      } catch (error) {
        console.error('Failed to parse OpenAI event:', error);
      }
    });

    ws.once('error', (error) => {
      clearTimeout(timeout);

      if (!opened) {
        reject(error);
        return;
      }

      console.error('OpenAI WebSocket error:', error);
    });

    ws.on('close', (code, reasonBuffer) => {
      session.wsReady = false;

      const reason =
        reasonBuffer && reasonBuffer.length > 0
          ? reasonBuffer.toString()
          : 'No reason';

      console.log(`OpenAI Realtime closed for guild ${session.guildId}: ${code} ${reason}`);
    });
  });
}

function sendPcmChunkToRealtime(session, chunk) {
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return;
  if (!chunk || chunk.length === 0) return;

  session.inputBytes += chunk.length;

  session.ws.send(
    JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: chunk.toString('base64'),
    }),
  );
}

function commitUserAudio(session, userId) {
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return;
  if (!session.inputBytes || session.inputBytes <= 0) return;

  if (session.inputBytes < MIN_INPUT_BYTES) {
    console.log(`Ignoring short audio chunk (${session.inputBytes} bytes) from ${userId}`);
    session.inputBytes = 0;
    return;
  }

  console.log(`Committing ${session.inputBytes} bytes of audio for ${userId}`);

  session.ws.send(
    JSON.stringify({
      type: 'input_audio_buffer.commit',
    }),
  );

  session.ws.send(
    JSON.stringify({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions:
          'Reply only in Hebrew. Never speak Arabic. If the audio is unclear, ask the user to repeat in Hebrew.',
      },
    }),
  );

  session.inputBytes = 0;
}

function cleanupInputTracker(session, userId) {
  const tracker = session.inputTrackers.get(userId);
  if (!tracker) return;

  tracker.closed = true;

  try {
    tracker.opusStream.destroy();
  } catch {}

  try {
    tracker.decoder.destroy();
  } catch {}

  try {
    tracker.resampler.stdin.destroy();
  } catch {}

  try {
    tracker.resampler.stdout.destroy();
  } catch {}

  try {
    tracker.resampler.kill('SIGKILL');
  } catch {}

  if (session.activeSpeakerId === userId) {
    session.activeSpeakerId = null;
  }

  session.inputTrackers.delete(userId);
}

function startReceivingUser(session, userId) {
  if (!isAllowedUser(userId)) return;
  if (session.inputTrackers.has(userId)) return;
  if (session.currentOutput) return;

  const now = Date.now();

  if (session.lastOutputAt && now - session.lastOutputAt < INPUT_COOLDOWN_MS) {
    return;
  }

  if (session.activeSpeakerId && session.activeSpeakerId !== userId) {
    return;
  }

  session.activeSpeakerId = userId;
  session.inputBytes = 0;

  const opusStream = session.connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: SILENCE_DURATION_MS,
    },
  });

  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  const resampler = spawn(ffmpegPath, [
    '-loglevel',
    'error',
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-i',
    'pipe:0',
    '-f',
    's16le',
    '-ar',
    '24000',
    '-ac',
    '1',
    'pipe:1',
  ]);

  const tracker = {
    userId,
    opusStream,
    decoder,
    resampler,
    closed: false,
  };

  session.inputTrackers.set(userId, tracker);

  opusStream.on('error', (error) => {
    console.error(`Opus receive stream error for ${userId}:`, error);
    cleanupInputTracker(session, userId);
  });

  decoder.on('error', (error) => {
    console.error(`Opus decoder error for ${userId}:`, error);
    cleanupInputTracker(session, userId);
  });

  resampler.on('error', (error) => {
    console.error(`Resampler error for ${userId}:`, error);
    cleanupInputTracker(session, userId);
  });

  resampler.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) {
      console.error(`Input resampler stderr for ${userId}:`, text);
    }
  });

  resampler.stdout.on('data', (chunk) => {
    sendPcmChunkToRealtime(session, chunk);
  });

  const safeCleanup = () => {
    if (tracker.closed) return;

    commitUserAudio(session, userId);
    cleanupInputTracker(session, userId);
  };

  opusStream.on('end', safeCleanup);
  opusStream.on('close', safeCleanup);
  resampler.stdout.on('close', () => {});

  opusStream.pipe(decoder).pipe(resampler.stdin);

  console.log(`Started receiving voice from user ${userId} in guild ${session.guildId}`);
}

function attachReceiver(session) {
  session.connection.receiver.speaking.on('start', (userId) => {
    if (!isAllowedUser(userId)) return;
    startReceivingUser(session, userId);
  });
}

function destroyGuildSession(guildId) {
  const session = guildSessions.get(guildId);
  if (!session) return;

  for (const userId of session.inputTrackers.keys()) {
    cleanupInputTracker(session, userId);
  }

  stopCurrentOutput(session);

  try {
    session.player.stop(true);
  } catch {}

  try {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.close();
    }
  } catch {}

  try {
    if (session.connection) {
      session.connection.destroy();
    }
  } catch {}

  guildSessions.delete(guildId);
}

async function createGuildSession(voiceChannel) {
  const guildId = voiceChannel.guild.id;

  destroyGuildSession(guildId);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 15000);

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  const session = {
    guildId,
    connection,
    player,
    ws: null,
    wsReady: false,
    currentOutput: null,
    inputTrackers: new Map(),
    inputBytes: 0,
    lastOutputAt: 0,
    activeSpeakerId: null,
  };

  player.on('error', (error) => {
    console.error(`Audio player error in guild ${guildId}:`, error);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    if (session.currentOutput && session.currentOutput.closing) {
      session.currentOutput = null;
      session.lastOutputAt = Date.now();
    }
  });

  connection.on('error', (error) => {
    console.error(`Voice connection error in guild ${guildId}:`, error);
  });

  connection.subscribe(player);

  guildSessions.set(guildId, session);

  attachReceiver(session);
  await createRealtimeSocket(session);

  return session;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('clientReady', () => {
  console.log(`Bot is online: ${client.user.tag}`);

  if (allowedUserIds.size > 0) {
    console.log(`Allowed users: ${Array.from(allowedUserIds).join(', ')}`);
  } else {
    console.log('Allowed users: all users');
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: 'You are not allowed to use this bot.',
      flags: 64,
    });
    return;
  }

  if (interaction.commandName === 'join') {
    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      await interaction.reply({
        content: 'You need to join a voice channel first.',
        flags: 64,
      });
      return;
    }

    const permissions = voiceChannel.permissionsFor(interaction.guild.members.me);

    if (!permissions?.has(PermissionFlagsBits.Connect)) {
      await interaction.reply({
        content: 'I do not have permission to connect to this voice channel.',
        flags: 64,
      });
      return;
    }

    if (!permissions?.has(PermissionFlagsBits.Speak)) {
      await interaction.reply({
        content: 'I do not have permission to speak in this voice channel.',
        flags: 64,
      });
      return;
    }

    try {
      await createGuildSession(voiceChannel);

      await interaction.reply({
        content: `Joined voice channel: ${voiceChannel.name}. Live voice mode is now active.`,
        flags: 64,
      });
    } catch (error) {
      console.error('Failed to join voice channel:', error);

      destroyGuildSession(interaction.guild.id);

      await interaction.reply({
        content: 'Failed to start live voice mode. Check OpenAI credits, token, and permissions.',
        flags: 64,
      });
    }

    return;
  }

  if (interaction.commandName === 'leave') {
    const guildId = interaction.guild.id;
    const connection = getVoiceConnection(guildId);

    if (!connection && !guildSessions.has(guildId)) {
      await interaction.reply({
        content: 'I am not connected to a voice channel.',
        flags: 64,
      });
      return;
    }

    destroyGuildSession(guildId);

    await interaction.reply({
      content: 'Disconnected from the voice channel.',
      flags: 64,
    });

    return;
  }

  if (interaction.commandName === 'testvoice') {
    await interaction.reply({
      content: 'testvoice is disabled in live mode. Use /join and then speak.',
      flags: 64,
    });
  }
});

client.login(DISCORD_TOKEN);
