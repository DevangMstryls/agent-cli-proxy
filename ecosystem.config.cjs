module.exports = {
  apps: [
    {
      name: 'agent-cli-proxy',
      script: 'dist/server.js',
      cwd: __dirname,
      autorestart: true,
      env: {},
    },
  ],
};
