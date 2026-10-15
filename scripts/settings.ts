import { launchVoice } from '../server/launch.ts';
console.log((await launchVoice()).settingsUrl);
