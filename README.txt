This is the component used by Homedome to validate an uploaded game.

It is built as a docker image, eg.
`docker build -t tang2 . -f Poker-Dockerfile`

The homedome worker downloads game data and calls this stuff via `docker run`
