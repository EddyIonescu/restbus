var restbus = require('./lib/restbus');

const PORT = '3535';
if (process.argv[2] === 'run') {
  restbus.listen(PORT);
  console.log(`Listening on Port ${PORT}`);
}

module.exports = restbus;
