"use client";

import { ArrowRight, ExternalLink } from "lucide-react";

import { startScreenStore } from "../model/startScreenState";
import { LEARN_RESOURCES, KEY_GROUPS } from "./LearnSection.model";

export function LearnSection() {
  return (
    <>
      <div className="fm-start-page-head">
        <div className="fm-start-page-head__copy">
          <h1>Learn</h1>
          <p>The things you look up rather than memorise.</p>
        </div>
      </div>

      <section aria-labelledby="fm-start-resources-title" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-resources-title">
          Resources
        </h2>
        <div className="fm-start-resources">
          {LEARN_RESOURCES.map((resource) =>
            resource.page ? (
              <button
                className="fm-start-resource-card"
                key={resource.title}
                onClick={() => startScreenStore.requestDocs(resource.page)}
                type="button"
              >
                <div className="fm-start-resource-card__head">
                  <span className="fm-start-resource-card__title">{resource.title}</span>
                  <ArrowRight aria-hidden="true" size={14} />
                </div>
                <p className="fm-start-resource-card__desc">{resource.description}</p>
              </button>
            ) : (
              <a
                className="fm-start-resource-card"
                href={resource.href}
                key={resource.title}
                rel="noreferrer"
                target="_blank"
              >
                <div className="fm-start-resource-card__head">
                  <span className="fm-start-resource-card__title">{resource.title}</span>
                  <ExternalLink aria-hidden="true" size={14} />
                </div>
                <p className="fm-start-resource-card__desc">{resource.description}</p>
              </a>
            ),
          )}
        </div>
      </section>

      <section aria-labelledby="fm-start-keys-title" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-keys-title">
          Keyboard map
        </h2>
        {KEY_GROUPS.map((group) => (
          <div className="fm-start-keys" key={group.title}>
            <h3 className="fm-start-kv__title">{group.title}</h3>
            <dl className="fm-start-kv__grid">
              {group.rows.map((row) => (
                <div className="fm-start-kv__row" key={row.action}>
                  <dt>{row.action}</dt>
                  <dd>{row.keys}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>

      <p className="fm-start-notice">
        Every start-screen action is also listed in the command palette (Ctrl ⇧ P).
      </p>
    </>
  );
}
