import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError, TimeoutError } from '@jackwener/opencli/errors';
import { saveBase64ToFile } from '@jackwener/opencli/utils';
import {
  AISTUDIO_DOMAIN,
  AISTUDIO_HOME,
  AISTUDIO_SPEECH_HOME,
  clickAIStudioSpeechRunButton,
  createAIStudioDeadline,
  exportAIStudioSpeechAudio,
  navigateAIStudioPage,
  nextAvailableAIStudioPath,
  openAIStudioSpeechEditor,
  readAIStudioModels,
  readAIStudioSpeechState,
  requirePositiveInteger,
  resolveAIStudioOutputDir,
  resolveModelChoice,
  aiStudioExtensionFromMime,
  waitForAIStudioState,
} from './utils.js';

// The speech studio is a dedicated surface (/generate-speech), not a chat
// page: the script goes into fixed textareas, submission is the shared
// ms-run-button, and each take renders into an <audio> player in the footer.
export const audioCommand = cli({
  site: 'aistudio',
  name: 'audio',
  access: 'write',
  description: 'Generate speech audio with Google AI Studio TTS models and save it locally',
  domain: AISTUDIO_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  defaultFormat: 'plain',
  args: [
    { name: 'prompt', positional: true, required: true, help: 'Script to speak; supports [pause] and [laughs] style speech tags' },
    {
      name: 'model',
      type: 'string',
      default: '',
      help: 'TTS model id or unique name (default: first available audio model)',
    },
    { name: 'output-dir', type: 'string', help: 'Output directory (default: ~/Music/aistudio)' },
    { name: 'skip-download', type: 'bool', default: false, help: 'Do not download; return the AI Studio link only' },
    { name: 'timeout', type: 'int', default: 240, help: 'Maximum generation time in seconds (default: 240)' },
  ],
  columns: ['status', 'file', 'model', 'duration', 'link'],
  func: async (page, kwargs) => {
    const timeout = requirePositiveInteger(kwargs.timeout, '--timeout');
    const deadline = createAIStudioDeadline(timeout);
    if (!String(kwargs.prompt || '').trim()) throw new ArgumentError('prompt must not be empty');

    // Default model discovery runs on the chat surface where the shared model
    // picker machinery works unchanged; the speech page pins the choice again
    // through its ?model= URL below. readAIStudioModels returns every card on
    // the Audio tab (including music models such as Lyria), so the category
    // filter keeps non-TTS models out and the tts-id preference keeps a music
    // model from becoming the default pick.
    let modelArg = String(kwargs.model || '').trim();
    if (!modelArg) {
      await navigateAIStudioPage(page, AISTUDIO_HOME, { deadline });
      const audioModels = await readAIStudioModels(page, 'audio', { deadline });
      const first = audioModels.find((row) => row.category === 'audio' && row.model.includes('tts'))
        ?? audioModels.find((row) => row.category === 'audio');
      if (!first) {
        throw new EmptyResultError('aistudio audio', 'No audio models are available for the current account');
      }
      modelArg = first.model;
    } else {
      // A canonical id pins the speech page directly through its ?model= URL
      // (lowercased, because the page readback always reports lowercase ids).
      // Any other spelling is a friendly name and resolves through the same
      // picker machinery the image/video commands use.
      const canonical = modelArg.match(/^(?:gemini|imagen|veo|lyria|gemma)-[a-z0-9][a-z0-9.-]*$/i);
      if (canonical) {
        modelArg = canonical[0].toLowerCase();
      } else {
        await navigateAIStudioPage(page, AISTUDIO_HOME, { deadline });
        const audioModels = await readAIStudioModels(page, 'audio', { deadline });
        modelArg = resolveModelChoice(audioModels, modelArg, 'audio').model;
      }
    }

    await navigateAIStudioPage(page, `${AISTUDIO_SPEECH_HOME}?model=${encodeURIComponent(modelArg)}`, { deadline });
    const state = await openAIStudioSpeechEditor(page, modelArg, { deadline });

    const baseline = new Set(state.audios.map((audio) => audio.srcKey).filter(Boolean));
    const inputSelector = 'textarea[aria-label="Speech block text"], textarea[aria-label*="Speech block" i]';
    const filled = await page.fillText(inputSelector, String(kwargs.prompt)).catch(() => null);
    if (!filled?.verified) {
      throw new CommandExecutionError(
        'Failed to insert the script into the AI Studio speech editor',
        `The "Speech block text" textarea did not accept the ${String(kwargs.prompt).length}-character script.`,
      );
    }

    // One submission action per run: the speech Run button is the shared
    // ms-run-button submit; never issue a second click if the take is slow.
    const runClicked = await clickAIStudioSpeechRunButton(page);
    if (!runClicked?.ok) {
      throw new CommandExecutionError('Failed to start AI Studio speech generation', runClicked?.reason || 'Run click failed');
    }

    const settled = await waitForAIStudioState(
      page,
      'AI Studio speech generation',
      () => readAIStudioSpeechState(page),
      (current) => {
        const fresh = (current?.audios || []).filter((audio) => audio.ready && audio.srcKey && !baseline.has(audio.srcKey));
        return fresh.length > 0;
      },
      {
        deadline,
        timeoutSeconds: timeout,
        pollSeconds: 0.5,
        timeoutMessage: 'AI Studio did not produce a speech audio take before the shared deadline.',
      },
    );
    const freshTakes = settled.audios.filter((audio) => audio.ready && audio.srcKey && !baseline.has(audio.srcKey));
    const take = freshTakes[freshTakes.length - 1];
    if (!take) {
      throw new EmptyResultError('aistudio audio', 'AI Studio completed without a speech audio take.');
    }
    const responseUrl = settled.url;

    if (kwargs['skip-download']) {
      return [{
        status: 'generated',
        file: null,
        model: modelArg,
        duration: take.duration || null,
        link: responseUrl,
      }];
    }

    let asset = null;
    try {
      asset = await exportAIStudioSpeechAudio(page, take.srcKey, { deadline });
    } catch (error) {
      // Deadline exhaustion must still point the user at the generated take.
      if (error instanceof TimeoutError) {
        throw new TimeoutError(
          'AI Studio audio export',
          timeout,
          'The shared --timeout deadline expired while exporting the take. '
            + `The take is still in AI Studio: open ${responseUrl} and download it manually.`,
        );
      }
      throw error;
    }
    if (!asset?.dataUrl) {
      throw new CommandExecutionError(
        'AI Studio generated speech audio, but the adapter could not export its bytes',
        `Open ${responseUrl} and download the audio manually.`,
      );
    }
    const outputDir = resolveAIStudioOutputDir(kwargs['output-dir'], path.join(os.homedir(), 'Music', 'aistudio'));
    await fs.promises.mkdir(outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const file = nextAvailableAIStudioPath(outputDir, `aistudio_${timestamp}`, aiStudioExtensionFromMime(asset.mimeType));
    const base64 = String(asset.dataUrl).replace(/^data:[^;]+;base64,/, '');
    await saveBase64ToFile(base64, file);
    const stat = await fs.promises.stat(file);
    if (!stat.size) {
      throw new CommandExecutionError(
        'AI Studio audio export produced an empty file',
        `The browser returned audio data for the take, but ${file} is empty.`,
      );
    }
    return [{
      status: 'saved',
      file,
      model: modelArg,
      duration: asset.duration || take.duration || null,
      link: responseUrl,
    }];
  },
});
