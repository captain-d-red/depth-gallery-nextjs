import { LongTake } from '@/components/long-take/LongTake';
import { catalogue } from '@/data/catalogue';

export default function Home() {
  return (
    <main>
      <LongTake />
      <section className="sr-only" aria-labelledby="index-heading">
        <h1 id="index-heading">Long Take, seventy-two films from 2010 to 2025</h1>
        <ol>
          {catalogue.films.map((film) => (
            <li key={film.slug}>
              <h2>
                {film.title} ({film.year})
              </h2>
              <p>
                Directed by {film.director}, {film.minutes} minutes. {film.logline}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
