// The fleet's addresses and ssh account come from the environment, so every
// test file starts with the same documentation-range fleet (RFC 5737) in
// meleys, vermithor, caraxes, syrax, vhagar order. A test that needs another
// value stubs it with vi.stubEnv, which restores these afterwards.
process.env.FM_HOST_IPS = '192.0.2.2,192.0.2.3,192.0.2.4,192.0.2.5,192.0.2.6'
process.env.FM_SSH_USER = 'fleet'
