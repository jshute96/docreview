export default function NotFound() {
  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-zinc-800 mb-2">404</h1>
        <p className="text-zinc-500 mb-6">The page you requested was not found.</p>
        <a
          href="/docs"
          className="inline-flex items-center px-4 py-2 rounded-md bg-zinc-800 text-white text-sm hover:bg-zinc-700 transition-colors"
        >
          Go to Documents
        </a>
      </div>
    </div>
  );
}
