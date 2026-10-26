import type { Language } from '@shared/types.ts';
import storyEn from '../../../content/story.en.json';
import storyPt from '../../../content/story.pt.json';

export type Story = typeof storyEn;

const stories: Record<Language, Story> = { en: storyEn, pt: storyPt };

export function story(language: Language): Story {
  return stories[language];
}
