import { launchTower } from '../server/launch.ts';
console.log((await launchTower()).settingsUrl);
