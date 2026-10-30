import { describeSkillSetsContract } from '../skills/skill-sets-contract.ts';
import { FakeSkillSets } from './fake-skill-sets.ts';

describeSkillSetsContract('the fake skill sets', async () => {
  const skillSets = new FakeSkillSets();
  let pins = 0;
  return {
    skillSets,
    async movePin() {
      skillSets.pin(String(++pins).repeat(16));
    },
    isBuilt: (version) => skillSets.built.has(version),
    async dispose() {},
  };
});
