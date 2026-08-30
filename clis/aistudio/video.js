import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { saveBase64ToFile } from '@jackwener/opencli/utils';
import {
  AISTUDIO_DOMAIN,
  AISTUDIO_VIDEO_HOME,
  applyAIStudioSettings,
  createAIStudioDeadline,
  exportAIStudioVideoAsset,
  focusAIStudioComposer,
  nextAvailableAIStudioPath,
  readAIStudioModels,
  readAIStudioVideoState,
  requirePositiveInteger,
  resolveAIStudioOutputDir,
  aiStudioExtensionFromMime,
  startNewAIStudioChat,
  submitAIStudioComposerWithKeyboard,
  waitForAIStudioState,
  waitForAIStudioVideoSubmission,
} from './utils.js';

// Veo runs on the chat-like surface /prompts/new_video, but that surface
// renders no ms-chat-turn nodes: prompts echo as .turn-prompt rows and every
// take lands in an ms-video-generation-gallery as a blob <video>. Setup and
// submission reuse the chat machinery; waiting and extraction are Veo-specific.
export const videoCommand = cli({
  site: 'aistudio',
  name: 'video',
  access: 'write',
  description: 'Generate videos with Google AI Studio Veo models and save them locally',
  domain: AISTUDIO_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  defaultFormat: 'plain',
  args: [
    { name: 'prompt', positional: true, required: true, help: 'Video generation prompt' },
    {
      name: 'model',
      type: 'string',
      default: '',
      help: 'Video model id or unique name (default: first available video model)',
    },
    { name: 'aspect-ratio', type: 'string', default: '16:9', help: 'Aspect ratio shown by the model, e.g. 16:9, 9:16' },
    { name: 'duration', type: 'string', help: 'Video duration shown by the model, e.g. 8s (omitted = leave unchanged)' },
    { name: 'output-dir', type: 'string', help: 'Output directory (default: ~/Videos/aistudio)' },
    { name: 'skip-download', type: 'bool', default: false, help: 'Do not download; return the AI Studio prompt link only' },
    { name: 'timeout', type: 'int', default: 600, help: 'Maximum generation time in seconds (default: 600)' },
  ],
  columns: ['status', 'file', 'model', 'duration', 'link'],
  func: async (page, kwargs) => {
    const timeout = requirePositiveInteger(kwargs.timeout, '--timeout');
    const deadline = createAIStudioDeadline(timeout);
    if (!String(kwargs.prompt || '').trim()) throw new ArgumentError('prompt must not be empty');

    await startNewAIStudioChat(page, { home: AISTUDIO_VIDEO_HOME, deadline });
    let modelArg = String(kwargs.model || '').trim();
    if (!modelArg) {
      const videoModels = await readAIStudioModels(page, 'video', { deadline });
      const first = videoModels.find((row) => row.category === 'video');
      if (!first) {
        throw new EmptyResultError('aistudio video', 'No video models are available for the current account');
      }
      modelArg = first.model;
    }
    const settings = await applyAIStudioSettings(page, {
      model: modelArg,
      requiredCategory: 'video',
      aspectRatio: kwargs['aspect-ratio'],
      videoDuration: kwargs.duration,
      deadline,
    });

    const baselineState = await readAIStudioVideoState(page);
    if (!baselineState.hasComposer) {
      throw new CommandExecutionError('AI Studio video prompt editor was not found');
    }
    const baseline = new Set(baselineState.gallery.map((video) => video.src).filter(Boolean));

    const composerSelector = baselineState.composerSelector;
    await focusAIStudioComposer(page, composerSelector);
    const filled = await page.fillText(composerSelector, String(kwargs.prompt)).catch(() => null);
    if (!filled?.verified) {
      throw new CommandExecutionError(
        'Failed to insert the prompt into the AI Studio video editor',
        `Expected a ${String(kwargs.prompt).length}-character prompt in the composer.`,
      );
    }

    // One submission action per run (native shortcut on a visible tab, one Run
    // click otherwise). The Veo surface never clears the composer, so the
    // wait below keys on the prompt echo / gallery growth instead of the
    // chat-turn evidence the ask flow uses.
    await submitAIStudioComposerWithKeyboard(page, {
      composerSelector,
      expectedText: String(kwargs.prompt),
      deadline,
    });
    await waitForAIStudioVideoSubmission(page, baseline, kwargs.prompt, { deadline });

    // Takes render for minutes. A ready take has decoded dimensions and a
    // positive duration; the deadline bounds the wait.
    const settled = await waitForAIStudioState(
      page,
      'AI Studio video generation',
      () => readAIStudioVideoState(page),
      (current) => (current?.gallery || []).some((video) => video.ready && video.src && !baseline.has(video.src)),
      {
        deadline,
        timeoutSeconds: timeout,
        pollSeconds: 1,
        timeoutMessage: 'AI Studio did not finish rendering a video take before the shared deadline.',
      },
    );
    const takes = settled.gallery.filter((video) => video.ready && video.src && !baseline.has(video.src));
    if (!takes.length) {
      throw new EmptyResultError('aistudio video', 'AI Studio completed without a generated video take.');
    }
    const responseUrl = settled.url;

    if (kwargs['skip-download']) {
      return takes.map((take) => ({
        status: 'generated',
        file: null,
        model: settings.model,
        duration: take.duration || null,
        link: responseUrl,
      }));
    }

    const outputDir = resolveAIStudioOutputDir(kwargs['output-dir'], path.join(os.homedir(), 'Videos', 'aistudio'));
    await fs.promises.mkdir(outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const rows = [];
    for (let index = 0; index < takes.length; index += 1) {
      const take = takes[index];
      const suffix = takes.length > 1 ? `_${index + 1}` : '';
      const file = nextAvailableAIStudioPath(outputDir, `aistudio_${timestamp}${suffix}`, aiStudioExtensionFromMime('video/mp4'));
      const asset = await exportAIStudioVideoAsset(page, take.src, { deadline });
      if (!asset?.dataUrl) {
        throw new CommandExecutionError(
          `AI Studio returned ${takes.length} video take(s), but take ${index + 1} could not be exported`,
          `Open ${responseUrl} and download the missing video(s) manually.`,
        );
      }
      const base64 = String(asset.dataUrl).replace(/^data:[^;]+;base64,/, '');
      await saveBase64ToFile(base64, file);
      const stat = await fs.promises.stat(file);
      if (!stat.size) {
        throw new CommandExecutionError(
          'AI Studio video export produced an empty file',
          `The browser returned video data for ${take.src || 'an unknown take'}, but ${file} is empty.`,
        );
      }
      rows.push({
        status: 'saved',
        file,
        model: settings.model,
        duration: asset.duration || take.duration || null,
        link: responseUrl,
      });
    }
    return rows;
  },
});
