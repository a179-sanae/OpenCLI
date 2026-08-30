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
  nextAvailableAIStudioPath,
  readAIStudioModels,
  requirePositiveInteger,
  resolveAIStudioOutputDir,
  aiStudioExtensionFromMime,
  sendAIStudioMessage,
  startNewAIStudioChat,
  waitForAIStudioResponse,
} from './utils.js';

// Veo renders one or more takes into <video> elements inside the model turn of
// the /prompts/new_video chat surface, so the whole chat machinery (snapshot,
// single-submit contract, response waiting) is reused unchanged.
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
      const first = videoModels[0];
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

    const submission = await sendAIStudioMessage(page, kwargs.prompt, { deadline });
    // Veo renders for minutes. A ticking progress label counts as activity,
    // and the stall/empty-shell windows are widened to render scale so a slow
    // render survives while a frozen one still fails before the deadline.
    const response = await waitForAIStudioResponse(page, submission, timeout, {
      deadline,
      stallTimeoutSeconds: 180,
      emptyShellTimeoutSeconds: 300,
    });
    const videos = response.videos || [];
    if (!videos.length) {
      throw new EmptyResultError(
        'aistudio video',
        response.text
          ? `AI Studio returned text but no video: ${response.text.slice(0, 240)}`
          : 'AI Studio completed without a generated video.',
      );
    }

    if (kwargs['skip-download']) {
      return videos.map((video) => ({
        status: 'generated',
        file: null,
        model: settings.model,
        duration: video.duration || null,
        link: response.url,
      }));
    }

    const outputDir = resolveAIStudioOutputDir(kwargs['output-dir'], path.join(os.homedir(), 'Videos', 'aistudio'));
    await fs.promises.mkdir(outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const rows = [];
    for (let index = 0; index < videos.length; index += 1) {
      const video = videos[index];
      const suffix = videos.length > 1 ? `_${index + 1}` : '';
      const file = nextAvailableAIStudioPath(outputDir, `aistudio_${timestamp}${suffix}`, '.mp4');
      const asset = await exportAIStudioVideoAsset(page, video.src, { deadline });
      if (!asset?.dataUrl) {
        throw new CommandExecutionError(
          `AI Studio returned ${videos.length} video take(s), but take ${index + 1} could not be exported`,
          `Open ${response.url} and download the missing video(s) manually.`,
        );
      }
      const base64 = String(asset.dataUrl).replace(/^data:[^;]+;base64,/, '');
      await saveBase64ToFile(base64, file);
      const stat = await fs.promises.stat(file);
      if (!stat.size) {
        throw new CommandExecutionError(
          'AI Studio video export produced an empty file',
          `The browser returned video data for ${video.src || 'an unknown take'}, but ${file} is empty.`,
        );
      }
      rows.push({
        status: 'saved',
        file,
        model: settings.model,
        duration: asset.duration || video.duration || null,
        link: response.url,
      });
    }
    return rows;
  },
});
