// Deterministic, purely cosmetic display name derived from an address.
// No randomness is stored anywhere and no request is made -- the same addr
// always maps to the same nickname, on every device, forever. This is what
// lets "AmberFalcon42" mean something without the server ever assigning or
// tracking identities.
'use strict';

const ADJECTIVES = [
  'Amber', 'Silent', 'Rapid', 'Cosmic', 'Hollow', 'Velvet', 'Rusty', 'Frozen',
  'Wild', 'Lucky', 'Quiet', 'Bright', 'Shadow', 'Gilded', 'Nomad', 'Feral',
  'Crimson', 'Azure', 'Midnight', 'Golden', 'Stormy', 'Mellow', 'Vivid', 'Lone',
  'Neon', 'Dusty', 'Electric', 'Phantom', 'Solar', 'Arctic'
];

const NOUNS = [
  'Falcon', 'Otter', 'Panther', 'Sparrow', 'Wolf', 'Lynx', 'Heron', 'Fox',
  'Badger', 'Raven', 'Tiger', 'Hawk', 'Cobra', 'Marlin', 'Bison', 'Coyote',
  'Osprey', 'Jaguar', 'Mongoose', 'Falcon', 'Viper', 'Puma', 'Gecko', 'Wren',
  'Orca', 'Ibis', 'Stag', 'Kite', 'Lemur', 'Newt'
];

export function nicknameFromAddr(addr) {
  let h = 0;
  for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
  const adj = ADJECTIVES[h % ADJECTIVES.length];
  const noun = NOUNS[(h >>> 8) % NOUNS.length];
  const num = h % 100;
  return `${adj}${noun}${num}`;
}
