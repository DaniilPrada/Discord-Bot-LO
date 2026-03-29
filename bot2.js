require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const prefix = process.env.PREFIX || '!';
const protectedUsername = 'michael_2024_pro';

const nudeAudioFiles = [
  process.env.NUDE_AUDIO_FILE_1 || path.join(__dirname, 'nude1.ogg'),
  process.env.NUDE_AUDIO_FILE_2 || path.join(__dirname, 'nude2.ogg'),
  process.env.NUDE_AUDIO_FILE_3 || path.join(__dirname, 'nude3.ogg'),
];

const parsedNudeDuration = Number.parseFloat(
  process.env.NUDE_AUDIO_DURATION_SECONDS || '2.4',
);

const nudeAudioDurationSeconds =
  Number.isFinite(parsedNudeDuration) && parsedNudeDuration > 0
    ? parsedNudeDuration
    : 2.4;

const WHAT_ARE_WE_COMMAND = 'מה אנחנו';
const WHAT_ARE_WE_REPLIES = [
  'חברים טובים כמו אחים',
  'אחים ביולוגים לנצח',
  'בני זוג מאמי',
  'מה אנחנו?',
];

const PROTECTED_REPLY_MESSAGE =
  'מי אתה חושב שאתה לעזאזל ? 😡 אל תתייג אותו';

if (!token) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function isProtectedUser(user) {
  if (!user) return false;

  const username = normalizeName(user.username);
  const globalName = normalizeName(user.globalName);

  return (
    username === normalizeName(protectedUsername) ||
    globalName === normalizeName(protectedUsername)
  );
}

function hasUserManageMessagesPermission(message) {
  return message.member?.permissions?.has(PermissionFlagsBits.ManageMessages);
}

function hasBotManageMessagesPermission(message) {
  return message.channel
    .permissionsFor(message.guild.members.me)
    ?.has(PermissionFlagsBits.ManageMessages);
}

function hasUserModerateMembersPermission(message) {
  return message.member?.permissions?.has(PermissionFlagsBits.ModerateMembers);
}

function hasBotModerateMembersPermission(message) {
  return message.guild.members.me?.permissions?.has(PermissionFlagsBits.ModerateMembers);
}

function hasBotSendMessagesPermission(message) {
  return message.channel
    .permissionsFor(message.guild.members.me)
    ?.has(PermissionFlagsBits.SendMessages);
}

function hasBotAttachFilesPermission(message) {
  return message.channel
    .permissionsFor(message.guild.members.me)
    ?.has(PermissionFlagsBits.AttachFiles);
}

function getRecentDeletableMessages(messages) {
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  return messages.filter((msg) => {
    const isRecentEnough = now - msg.createdTimestamp < fourteenDaysMs;
    return !msg.pinned && isRecentEnough;
  });
}

function parseDuration(input) {
  if (!input) return null;

  const match = input.trim().toLowerCase().match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;

  const value = Number.parseInt(match[1], 10);
  const unit = match[2];

  if (!Number.isInteger(value) || value <= 0) return null;

  const unitMap = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * unitMap[unit];
}

function buildWaveform(length = 64) {
  const bytes = new Uint8Array(length);

  for (let i = 0; i < length; i += 1) {
    const x = i / Math.max(length - 1, 1);
    const value =
      20 +
      Math.round(
        180 *
          Math.abs(Math.sin(x * Math.PI * 2.7)) *
          (0.35 + 0.65 * Math.sin(x * Math.PI)),
      );

    bytes[i] = Math.max(0, Math.min(255, value));
  }

  return Buffer.from(bytes).toString('base64');
}

function getAudioContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  const contentTypeMap = {
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
  };

  return contentTypeMap[extension] || null;
}

function getRandomNudeAudioFile() {
  return nudeAudioFiles[Math.floor(Math.random() * nudeAudioFiles.length)];
}

async function sendDiscordVoiceMessage(channel, filePath, durationSecs) {
  const audioBuffer = await fs.readFile(filePath);
  const fileName = path.basename(filePath);
  const contentType = getAudioContentType(filePath);

  if (!contentType) {
    throw new Error(
      'Unsupported audio format. Use .ogg, .opus, .mp3, .wav, .m4a, .aac, or .flac.',
    );
  }

  const waveform = buildWaveform();
  const form = new FormData();

  form.append(
    'files[0]',
    new Blob([audioBuffer], { type: contentType }),
    fileName,
  );

  form.append(
    'payload_json',
    JSON.stringify({
      flags: 1 << 13,
      attachments: [
        {
          id: '0',
          filename: fileName,
          duration_secs: durationSecs,
          waveform,
        },
      ],
    }),
  );

  const response = await fetch(
    `https://discord.com/api/v10/channels/${channel.id}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
      },
      body: form,
    },
  );

  const responseData = await response.json().catch(() => null);

  if (!response.ok) {
    const details =
      responseData && typeof responseData === 'object'
        ? JSON.stringify(responseData)
        : 'Unknown Discord API error';

    throw new Error(`Discord API request failed (${response.status}): ${details}`);
  }

  return responseData;
}

async function sendTemporaryMessage(channel, content, delayMs = 4000) {
  const sentMessage = await channel.send(content);

  setTimeout(() => {
    sentMessage.delete().catch(() => {});
  }, delayMs);
}

async function handleClearCommand(message, amount) {
  const fetchLimit = Math.min(amount + 1, 100);
  const fetchedMessages = await message.channel.messages.fetch({ limit: fetchLimit });
  const deletableMessages = getRecentDeletableMessages(fetchedMessages);

  await message.channel.bulkDelete(deletableMessages, true);

  const deletedUserMessages = Math.max(
    0,
    Math.min(amount, deletableMessages.filter((msg) => msg.id !== message.id).size),
  );

  await sendTemporaryMessage(
    message.channel,
    `Deleted ${deletedUserMessages} message(s).`,
  );
}

async function handleClearAllCommand(message) {
  let deletedTotal = 0;

  while (true) {
    const fetchedMessages = await message.channel.messages.fetch({ limit: 100 });
    const deletableMessages = getRecentDeletableMessages(fetchedMessages);

    if (deletableMessages.size === 0) {
      break;
    }

    await message.channel.bulkDelete(deletableMessages, true);
    deletedTotal += deletableMessages.size;

    if (deletableMessages.size < 100) {
      break;
    }
  }

  await sendTemporaryMessage(
    message.channel,
    `Clear all completed. Deleted ${deletedTotal} recent message(s).`,
  );
}

async function isReplyToProtectedUser(message) {
  if (!message.reference?.messageId) return false;

  try {
    const repliedMessage = await message.fetchReference();
    return isProtectedUser(repliedMessage?.author);
  } catch {
    return false;
  }
}

client.once('clientReady', () => {
  console.log(`Bot is online: ${client.user.tag}`);
  console.log(`Prefix: ${prefix}`);
  console.log(`Protected username: ${protectedUsername}`);
  console.log(`Nude audio files: ${nudeAudioFiles.join(', ')}`);
  console.log(`Voice message duration: ${nudeAudioDurationSeconds}s`);
});

client.on('messageCreate', async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const mentionedProtectedUser = message.mentions.users.some((user) => isProtectedUser(user));
  const repliedToProtectedUser = await isReplyToProtectedUser(message);
  const authorIsProtectedUser = isProtectedUser(message.author);

  if (!authorIsProtectedUser && (mentionedProtectedUser || repliedToProtectedUser)) {
    await message.reply({
      content: PROTECTED_REPLY_MESSAGE,
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  if (!message.content.startsWith(prefix)) return;

  const content = message.content.slice(prefix.length).trim().replace(/\s+/g, ' ');
  const normalizedContent = content.toLowerCase();

  if (normalizedContent === WHAT_ARE_WE_COMMAND) {
    const randomReply =
      WHAT_ARE_WE_REPLIES[Math.floor(Math.random() * WHAT_ARE_WE_REPLIES.length)];

    await message.reply({
      content: randomReply,
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  const args = content.split(' ');
  const command = args.shift()?.toLowerCase();

  if (!command) return;

  if (command === 'ping') {
    await message.reply({
      content: 'Pong!',
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  if (command === 'prefix') {
    await message.reply({
      content: `Current prefix: ${prefix}`,
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  if (command === 'sm') {
    const text = args.join(' ').trim();

    if (!text) {
      await message.reply({
        content: `Usage: ${prefix}sm <message>`,
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    if (!hasBotManageMessagesPermission(message)) {
      await message.reply({
        content: 'I do not have permission to delete messages in this channel.',
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    await message.delete().catch(() => {});
    await message.channel.send(text);
    return;
  }

  if (command === 'nude') {
    if (!hasBotSendMessagesPermission(message)) {
      await sendTemporaryMessage(
        message.channel,
        'I do not have permission to send messages in this channel.',
      );
      return;
    }

    if (!hasBotAttachFilesPermission(message)) {
      await sendTemporaryMessage(
        message.channel,
        'I do not have permission to attach files in this channel.',
      );
      return;
    }

    const randomAudioFile = getRandomNudeAudioFile();

    try {
      await fs.access(randomAudioFile);
    } catch {
      await sendTemporaryMessage(
        message.channel,
        `Audio file not found: ${randomAudioFile}`,
      );
      return;
    }

    await message.delete().catch(() => {});

    try {
      await sendDiscordVoiceMessage(
        message.channel,
        randomAudioFile,
        nudeAudioDurationSeconds,
      );
    } catch (error) {
      console.error('Failed to send voice message:', error);

      await sendTemporaryMessage(
        message.channel,
        'Failed to send the voice message. Check file format, permissions, and audio duration.',
        6000,
      );
    }

    return;
  }

  if (command === 'mute') {
    if (!hasUserModerateMembersPermission(message)) {
      await sendTemporaryMessage(
        message.channel,
        'You do not have permission to use this command.',
      );
      return;
    }

    if (!hasBotModerateMembersPermission(message)) {
      await sendTemporaryMessage(
        message.channel,
        'I do not have permission to timeout members.',
      );
      return;
    }

    if (!hasBotManageMessagesPermission(message)) {
      await sendTemporaryMessage(
        message.channel,
        'I do not have permission to delete the command message.',
      );
      return;
    }

    const targetUser = message.mentions.users.first();
    const targetMember = message.mentions.members.first();
    const durationInput = args[1];
    const durationMs = parseDuration(durationInput);
    const reason = args.slice(2).join(' ').trim() || 'No reason provided';

    if (!targetUser || !targetMember) {
      await sendTemporaryMessage(
        message.channel,
        `Usage: ${prefix}mute @user <10m|1h|1d> [reason]`,
      );
      return;
    }

    if (!durationMs) {
      await sendTemporaryMessage(
        message.channel,
        `Usage: ${prefix}mute @user <10m|1h|1d> [reason]`,
      );
      return;
    }

    if (durationMs > 28 * 24 * 60 * 60 * 1000) {
      await sendTemporaryMessage(
        message.channel,
        'Maximum mute duration is 28 days.',
      );
      return;
    }

    if (targetUser.id === message.author.id) {
      await sendTemporaryMessage(
        message.channel,
        'You cannot mute yourself.',
      );
      return;
    }

    if (targetUser.id === client.user.id) {
      await sendTemporaryMessage(
        message.channel,
        'You cannot mute the bot.',
      );
      return;
    }

    if (!targetMember.moderatable) {
      await sendTemporaryMessage(
        message.channel,
        'I cannot mute this member. Check role hierarchy and permissions.',
      );
      return;
    }

    await message.delete().catch(() => {});
    await targetMember.timeout(durationMs, reason).catch(async () => {
      await sendTemporaryMessage(
        message.channel,
        'Failed to mute this member.',
      );
    });
    return;
  }

  if (command === 'unmute') {
    if (!hasUserModerateMembersPermission(message)) {
      await sendTemporaryMessage(
        message.channel,
        'You do not have permission to use this command.',
      );
      return;
    }

    if (!hasBotModerateMembersPermission(message)) {
      await sendTemporaryMessage(
        message.channel,
        'I do not have permission to timeout members.',
      );
      return;
    }

    if (!hasBotManageMessagesPermission(message)) {
      await sendTemporaryMessage(
        message.channel,
        'I do not have permission to delete the command message.',
      );
      return;
    }

    const targetUser = message.mentions.users.first();
    const targetMember = message.mentions.members.first();

    if (!targetUser || !targetMember) {
      await sendTemporaryMessage(
        message.channel,
        `Usage: ${prefix}unmute @user`,
      );
      return;
    }

    if (!targetMember.moderatable) {
      await sendTemporaryMessage(
        message.channel,
        'I cannot unmute this member. Check role hierarchy and permissions.',
      );
      return;
    }

    await message.delete().catch(() => {});
    await targetMember.timeout(null).catch(async () => {
      await sendTemporaryMessage(
        message.channel,
        'Failed to unmute this member.',
      );
    });
    return;
  }

  if (command === 'clear' || command === 'clearall') {
    if (!hasUserManageMessagesPermission(message)) {
      await sendTemporaryMessage(
        message.channel,
        'You do not have permission to use this command.',
      );
      return;
    }

    if (!hasBotManageMessagesPermission(message)) {
      await sendTemporaryMessage(
        message.channel,
        'I do not have permission to delete messages in this channel.',
      );
      return;
    }
  }

  if (command === 'clear') {
    const amount = Number.parseInt(args[0], 10);

    if (!Number.isInteger(amount)) {
      await sendTemporaryMessage(
        message.channel,
        `Usage: ${prefix}clear <amount>`,
      );
      return;
    }

    if (amount < 1 || amount > 99) {
      await sendTemporaryMessage(
        message.channel,
        'Please enter a number between 1 and 99.',
      );
      return;
    }

    await handleClearCommand(message, amount);
    return;
  }

  if (command === 'clearall') {
    await handleClearAllCommand(message);
  }
});

client.login(token);
