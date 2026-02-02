import type { PersonalityId, EmojiUsage, PersonalityQuirks } from '../../shared/types';

/**
 * Message keys used throughout the app
 */
export type MessageKey =
  | 'welcome'
  | 'welcomeSubtitle'
  | 'placeholder'
  | 'placeholderActive'
  | 'taskStart'
  | 'taskComplete'
  | 'taskWorking'
  | 'taskPaused'
  | 'taskBlocked'
  | 'planCreated'
  | 'stepStarted'
  | 'stepCompleted'
  | 'error'
  | 'approval'
  | 'verifying'
  | 'verifyPassed'
  | 'verifyFailed'
  | 'retrying'
  | 'disclaimer';

/**
 * Context for generating personalized messages
 */
export interface AgentMessageContext {
  agentName: string;
  userName?: string;
  personality: PersonalityId;
  emojiUsage: EmojiUsage;
  quirks: PersonalityQuirks;
}

/**
 * Message templates organized by personality type
 */
const MESSAGES: Record<PersonalityId, Record<MessageKey, string>> = {
  professional: {
    welcome: '{agentName} ready{userGreeting}.',
    welcomeSubtitle: 'How can I assist you today?',
    placeholder: 'What can I help with?',
    placeholderActive: 'Next task?',
    taskStart: 'Beginning task.',
    taskComplete: 'Complete.',
    taskWorking: 'Processing...',
    taskPaused: 'Paused.',
    taskBlocked: 'Needs approval.',
    planCreated: 'Strategy prepared.',
    stepStarted: 'Working on: {detail}',
    stepCompleted: 'Step complete.',
    error: 'Issue encountered.',
    approval: 'Decision required.',
    verifying: 'Verifying...',
    verifyPassed: 'Verification passed.',
    verifyFailed: 'Verification failed.',
    retrying: 'Retrying (attempt {n}).',
    disclaimer: '{agentName} can make mistakes. Please verify important information.',
  },
  friendly: {
    welcome: 'Hey{userGreeting}! {agentName} here.',
    welcomeSubtitle: "What should we work on?",
    placeholder: "What's up?",
    placeholderActive: "What's next?",
    taskStart: "Let's do this!",
    taskComplete: 'Done! Nice work.',
    taskWorking: 'On it...',
    taskPaused: 'Paused for now.',
    taskBlocked: 'Need your approval.',
    planCreated: "Here's the plan!",
    stepStarted: 'Tackling: {detail}',
    stepCompleted: 'Got it!',
    error: 'Oops, hit a snag.',
    approval: 'Need your input!',
    verifying: 'Checking our work...',
    verifyPassed: 'Looks good!',
    verifyFailed: 'Not quite right.',
    retrying: 'Trying again (#{n}).',
    disclaimer: '{agentName} can make mistakes. Double-check anything important!',
  },
  concise: {
    welcome: '{agentName} ready{userGreeting}.',
    welcomeSubtitle: 'Ready.',
    placeholder: 'Task?',
    placeholderActive: 'Next?',
    taskStart: 'Starting.',
    taskComplete: 'Done.',
    taskWorking: 'Working...',
    taskPaused: 'Paused.',
    taskBlocked: 'Blocked.',
    planCreated: 'Plan ready.',
    stepStarted: '{detail}',
    stepCompleted: 'Done.',
    error: 'Error.',
    approval: 'Input needed.',
    verifying: 'Checking...',
    verifyPassed: 'Passed.',
    verifyFailed: 'Failed.',
    retrying: 'Retry #{n}.',
    disclaimer: '{agentName} may err. Verify.',
  },
  creative: {
    welcome: '{agentName} awakens{userGreeting}.',
    welcomeSubtitle: "Let's create something amazing.",
    placeholder: 'What shall we dream up?',
    placeholderActive: 'What adventure awaits?',
    taskStart: 'The journey begins!',
    taskComplete: 'Masterpiece complete.',
    taskWorking: 'Crafting magic...',
    taskPaused: 'Time stands still.',
    taskBlocked: 'A gate awaits your key.',
    planCreated: 'The blueprint emerges.',
    stepStarted: 'Weaving: {detail}',
    stepCompleted: 'Another piece falls into place.',
    error: 'A twist in the tale.',
    approval: 'Your vision is needed.',
    verifying: 'Admiring our work...',
    verifyPassed: 'It shines!',
    verifyFailed: 'Needs refinement.',
    retrying: 'A fresh canvas (take {n}).',
    disclaimer: '{agentName} is creative, not infallible. Verify the important bits.',
  },
  technical: {
    welcome: '{agentName} online{userGreeting}.',
    welcomeSubtitle: 'Awaiting input.',
    placeholder: 'Enter command.',
    placeholderActive: 'Next command.',
    taskStart: 'Initiating.',
    taskComplete: 'Execution complete.',
    taskWorking: 'Processing...',
    taskPaused: 'Paused.',
    taskBlocked: 'Blocked: approval required.',
    planCreated: 'Execution plan generated.',
    stepStarted: 'Executing: {detail}',
    stepCompleted: 'Step executed.',
    error: 'Error encountered.',
    approval: 'Awaiting user input.',
    verifying: 'Running verification...',
    verifyPassed: 'Verification: PASS.',
    verifyFailed: 'Verification: FAIL.',
    retrying: 'Retry attempt {n}.',
    disclaimer: '{agentName} output may contain errors. Validate critical data.',
  },
  casual: {
    welcome: "Yo{userGreeting}! {agentName} here.",
    welcomeSubtitle: "What's the plan?",
    placeholder: 'So, what are we doing?',
    placeholderActive: 'And then?',
    taskStart: 'Alright, here we go.',
    taskComplete: 'Nailed it.',
    taskWorking: 'Doing the thing...',
    taskPaused: 'Paused for now.',
    taskBlocked: 'Need your ok.',
    planCreated: 'Got a game plan.',
    stepStarted: 'On it: {detail}',
    stepCompleted: 'Check.',
    error: 'Uh oh.',
    approval: 'Your call.',
    verifying: 'Just checking...',
    verifyPassed: 'We good.',
    verifyFailed: 'Hmm, not quite.',
    retrying: 'Round {n}, fight!',
    disclaimer: "{agentName} isn't perfect. Double-check the important stuff.",
  },
  custom: {
    welcome: '{agentName} ready{userGreeting}.',
    welcomeSubtitle: 'What should we work on?',
    placeholder: 'What should we work on?',
    placeholderActive: "What's next?",
    taskStart: 'Starting.',
    taskComplete: 'Done.',
    taskWorking: 'Working...',
    taskPaused: 'Paused.',
    taskBlocked: 'Needs approval.',
    planCreated: 'Plan ready.',
    stepStarted: 'Working on: {detail}',
    stepCompleted: 'Step complete.',
    error: 'Issue encountered.',
    approval: 'Input needed.',
    verifying: 'Verifying...',
    verifyPassed: 'Passed.',
    verifyFailed: 'Failed.',
    retrying: 'Retrying ({n}).',
    disclaimer: '{agentName} can make mistakes. Please verify important information.',
  },
};

/**
 * Add emoji based on emojiUsage setting
 */
function addEmoji(message: string, key: MessageKey, emojiUsage: EmojiUsage): string {
  if (emojiUsage === 'none') return message;

  const emojiMap: Partial<Record<MessageKey, string>> = {
    taskComplete: '✓',
    error: '⚠',
    approval: '❓',
    verifyPassed: '✓',
    verifyFailed: '✗',
  };

  const emoji = emojiMap[key];
  if (!emoji) return message;

  // For minimal, only add checkmarks
  if (emojiUsage === 'minimal' && !['taskComplete', 'verifyPassed', 'stepCompleted'].includes(key)) {
    return message;
  }

  return `${emoji} ${message}`;
}

/**
 * Get a personalized message
 */
export function getMessage(
  key: MessageKey,
  ctx: AgentMessageContext,
  detail?: string
): string {
  const { agentName, userName, personality, emojiUsage, quirks } = ctx;

  // Get base message for personality
  const messages = MESSAGES[personality] || MESSAGES.professional;
  let message = messages[key] || MESSAGES.professional[key] || key;

  // Replace placeholders
  const userGreeting = userName ? `, ${userName}` : '';
  message = message
    .replace('{agentName}', agentName)
    .replace('{userGreeting}', userGreeting)
    .replace('{detail}', detail || '')
    .replace('{n}', detail || '1');

  // Add emoji if appropriate
  message = addEmoji(message, key, emojiUsage);

  // Add catchphrase to welcome
  if (key === 'welcomeSubtitle' && quirks.catchphrase) {
    message = `${message} ${quirks.catchphrase}`;
  }

  // Add sign-off to completion
  if (key === 'taskComplete' && quirks.signOff) {
    message = `${message} ${quirks.signOff}`;
  }

  return message;
}

/**
 * Get a random placeholder from personality-appropriate options
 */
export function getRandomPlaceholder(ctx: AgentMessageContext): string {
  const { personality, userName, agentName } = ctx;

  const placeholders: Record<PersonalityId, string[]> = {
    professional: [
      'What can I help with?',
      'How may I assist?',
      `${agentName} standing by.`,
    ],
    friendly: [
      "What's on your mind?",
      "What's up?",
      'Ready when you are!',
      userName ? `What's next, ${userName}?` : "What's next?",
    ],
    concise: ['Task?', 'Input?', 'Next?'],
    creative: [
      'What shall we create?',
      'What adventure awaits?',
      "Let's make something.",
    ],
    technical: ['Enter command.', 'Awaiting input.', `${agentName} ready.`],
    casual: [
      "So what's the plan?",
      'What are we doing?',
      userName ? `What's up, ${userName}?` : "What's up?",
    ],
    custom: ['What should we work on?', "What's next?", `${agentName} ready.`],
  };

  const options = placeholders[personality] || placeholders.professional;
  return options[Math.floor(Math.random() * options.length)];
}

export default getMessage;
