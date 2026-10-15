# Read video sources through a loopback Range proxy

The video Executor serves each source to ffmpeg from a short-lived HTTP server
on `127.0.0.1`, at a random 256-bit path with no file extension, instead of
downloading the whole file first. The server forwards each `Range` request
ffmpeg makes to the origin and returns only its own headers. A one-second frame
usually needs a few MiB, so a 229 MiB video took 0.35 s instead of 16 s. An
origin that ignores `Range` gets the full download, and so does one that stops
honoring it or would have the proxy ask for more than one copy of the source.

ffmpeg could read the presigned URL directly, but it follows redirects itself,
with nothing to check them against the Space's allowed source origins, and it
would decide for itself how much of the source to read. Keeping the origin
behind the proxy keeps those checks in Node: each redirect hop is allowlisted,
the size limit comes from the origin's `Content-Range` total before anything is
decoded, and the proxy enforces a byte budget, a request budget, and per-request
idle timeouts. ffmpeg is limited to the `http` and `tcp` protocols and to a
list of real video containers, so a source cannot make it open a playlist,
another URL, or a local file. The proxy does not cache what it forwards, so
ffmpeg's re-reads reach the origin again; the byte budget bounds that.

ffmpeg asks for open-ended ranges and drops the connection when it seeks, so
passing its requests on as they are lets the origin send far more than ffmpeg
reads: 256 reads of 32 KiB each once pulled 643 MiB. The proxy therefore
answers each read as one response but asks the origin for it in windows, 256
KiB first and then each twice the last up to 4 MiB, and asks for the next window
only once ffmpeg has taken the last and is still connected. Every window must
come back as exactly the span asked for. Each is charged at its full length
before it is requested, and each origin request, redirect hops included, counts
against a budget of 256, so whatever ffmpeg does the origin is asked for at most
the source's size plus 16 MiB in at most 256 requests; a seek wastes at most the
window it abandons. Measured with ffmpeg 7.1.5 against an origin throttled to 20
MiB/s, the 229 MiB 1080p files, `moov` first or last, cost 4 MiB in 7 to 9
requests and the 204 MiB portrait 4K file 66 MiB in 26, against budgets of 245
and 220 MiB, in the same time as one request per read. Against an origin 40 ms
from first byte, the extra round trips add 0.1 to 0.2 s to a capture.

ffmpeg's read timeout is 150 s, 30 s beyond the longest the proxy can keep it
waiting on the origin: a window's request and its two redirect hops, then the
window's first bytes, 30 s each. A slow origin is therefore reported by the
proxy, as a retryable timeout, and never mistaken for a video ffmpeg could not
decode. If ffmpeg still abandons a read the origin has not answered, opens more
than four reads at once, or finds no frame through the proxy, the source is
downloaded and read locally. Only a complete local copy can show that a video is
corrupt, so a corrupt video costs one full download.
